/**
 * Application layer: orchestrates exactly one request end to end.
 *
 * classify -> decide -> execute (local, with cloud fallback) -> record metrics.
 */

import { CloudClient, ChatMessage, CompletionResult, LlmClientError } from '../cloud/cloudClient';
import { LocalModelClient } from '../local/localModelClient';
import { ClassifierWeights } from './classifierWeights';
import { DecisionRecord, DecisionRecordInput } from './decisionJournal';
import {
  applyLocalCondition,
  LocalCondition,
  LocalConditionOptions,
} from './localCondition';
import { classify, EditorContext, RequestFeatures, RouteKind } from './requestClassifier';
import { explainRoute, RouteDecision, RoutingPolicyOptions } from './routingPolicy';

export interface LedgerSink {
  record(route: RouteKind, estimatedTokens: number): Promise<unknown> | void;
}

/** Destination for the decision-quality journal; optional and fire-and-forget. */
export interface JournalSink {
  recordDecision(input: DecisionRecordInput): Promise<DecisionRecord> | void;
}

export interface RouterOptions extends RoutingPolicyOptions {
  /** When the local server is unreachable, transparently retry on the cloud. */
  fallbackToCloud: boolean;
  /** Classifier coefficients; omitted means the tuned defaults. */
  weights?: Partial<ClassifierWeights>;
  /** 本地状况提供者；每次预览时读取，便于健康探测刷新后立即生效。 */
  localCondition?: () => LocalCondition;
  /** 本地状况门控参数；与 {@link RouterOptions.localCondition} 一同提供才生效。 */
  localConditionOptions?: LocalConditionOptions;
  /** 执行前确保本地健康状况已刷新（缓存过期时触发探测）。 */
  ensureLocalHealth?: () => Promise<void>;
}

export interface RouteOutcome {
  requestId: string;
  route: RouteKind;
  fallbackUsed: boolean;
  features: RequestFeatures;
  decision: RouteDecision;
  completion: CompletionResult;
  latencyMs: number;
}

export interface RoutePreview {
  features: RequestFeatures;
  decision: RouteDecision;
}

export interface RouterDependencies {
  cloud: CloudClient;
  local: LocalModelClient | null;
  ledger: LedgerSink;
  options: RouterOptions;
  /** Decision-quality journal; optional because it is an analytics extra. */
  journal?: JournalSink;
}

let requestCounter = 0;

export function nextRequestId(): string {
  requestCounter += 1;
  return `req-${Date.now().toString(36)}-${requestCounter}`;
}

export function buildMessages(
  prompt: string,
  context: EditorContext = {}
): ChatMessage[] {
  const messages: ChatMessage[] = [
    {
      role: 'system',
      content:
        'You are a concise coding assistant embedded in VS Code. Answer directly and prefer short, correct code.',
    },
  ];

  if (context.selectedText) {
    messages.push({
      role: 'user',
      content: `Selected code from ${context.fileName ?? 'the editor'}:\n\n${context.selectedText}`,
    });
  }

  messages.push({ role: 'user', content: prompt });
  return messages;
}

export class Router {
  constructor(private readonly deps: RouterDependencies) {}

  /** Pure preview used by the UI to explain a decision before executing it. */
  preview(prompt: string, context: EditorContext = {}): RoutePreview {
    const features = classify(prompt, context, { weights: this.deps.options.weights });
    const base = explainRoute(
      features,
      this.deps.options.threshold,
      this.deps.options.enableLocalRouting
    );
    return { features, decision: this.applyLocalCondition(base) };
  }

  /** 叠加本地可用性 / 延迟门控；未配置时返回基础决策。 */
  private applyLocalCondition(base: RouteDecision): RouteDecision {
    const provider = this.deps.options.localCondition;
    const options = this.deps.options.localConditionOptions;
    if (!provider || !options) {
      return base;
    }
    return applyLocalCondition(base, provider(), options);
  }

  async route(
    prompt: string,
    context: EditorContext = {},
    signal?: AbortSignal
  ): Promise<RouteOutcome> {
    const startedAt = Date.now();
    // 缓存过期时先刷新健康探测，保证本次决策用的是最新可用性。
    await this.deps.options.ensureLocalHealth?.();
    // The id is minted up front so the ledger, the journal and the UI all refer
    // to the same request.
    const requestId = nextRequestId();
    const { features, decision } = this.preview(prompt, context);
    const messages = buildMessages(prompt, context);

    let route = decision.route;
    let fallbackUsed = false;
    let completion: CompletionResult;

    if (route === 'local' && this.deps.local) {
      try {
        completion = await this.deps.local.complete(messages, 'chat-completions', signal);
      } catch (error) {
        if (!this.deps.options.fallbackToCloud) {
          throw error;
        }
        fallbackUsed = true;
        route = 'cloud';
        completion = await this.completeOnCloud(messages, signal);
      }
    } else {
      if (route === 'local') {
        route = 'cloud';
        fallbackUsed = true;
      }
      completion = await this.completeOnCloud(messages, signal);
    }

    const latencyMs = Date.now() - startedAt;

    await this.deps.ledger.record(route, features.estimatedTokens);
    await this.deps.journal?.recordDecision({
      requestId,
      predictedRoute: decision.route,
      actualRoute: route,
      fallbackUsed,
      complexity: features.complexity,
      threshold: decision.threshold,
      tokenEstimate: features.estimatedTokens,
      latencyMs,
    });

    return {
      requestId,
      route,
      fallbackUsed,
      features,
      decision: { ...decision, route },
      completion,
      latencyMs,
    };
  }

  private async completeOnCloud(
    messages: ChatMessage[],
    signal?: AbortSignal
  ): Promise<CompletionResult> {
    if (!this.deps.cloud.isConfigured) {
      throw new LlmClientError('Cloud client is not configured (missing base URL or model)');
    }
    return this.deps.cloud.complete(messages, signal);
  }
}