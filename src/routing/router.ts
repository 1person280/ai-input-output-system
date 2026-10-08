/**
 * Application layer: orchestrates exactly one request end to end.
 *
 * 新流程：所有请求先过本地模型；本地判断自己能答就直接回答，复杂时输出
 * [ESCALATE] 求助标记，由云端专家回答子问题、本地整合出最终回复。
 * 仅当本地服务不可用/出错时，整个请求直接降级到云端。
 */

import {
  CloudClient,
  ChatMessage,
  CompletionResult,
  LlmClientError,
} from '../cloud/cloudClient';
import {
  EscalationRequest,
  LocalModelClient,
  parseLocalTurn,
} from '../local/localModelClient';
import { ClassifierWeights } from './classifierWeights';
import { DecisionRecord, DecisionRecordInput } from './decisionJournal';
import { classify, EditorContext, RequestFeatures, RouteKind } from './requestClassifier';

export interface LedgerSink {
  record(route: RouteKind, estimatedTokens: number): Promise<unknown> | void;
}

/** Destination for the decision-quality journal; optional and fire-and-forget. */
export interface JournalSink {
  recordDecision(input: DecisionRecordInput): Promise<DecisionRecord> | void;
}

export interface RouterOptions {
  /** 是否允许本地模型求助云端专家；关闭后本地答不好也不再升级。 */
  escalationEnabled: boolean;
  /** 本地服务不可达时透明降级到云端（整个请求）。 */
  fallbackToCloud: boolean;
  /** Classifier coefficients; omitted means the tuned defaults（仅用于统计特征）。 */
  weights?: Partial<ClassifierWeights>;
}

export interface RouteOutcome {
  requestId: string;
  route: RouteKind;
  /** 本地模型声明的求助信息（仅 escalated 路由存在）。 */
  escalation?: EscalationRequest;
  /** 专家对子问题的回答（仅 escalated 路由存在）。 */
  expertAnswer?: string;
  features: RequestFeatures;
  completion: CompletionResult;
  latencyMs: number;
}

export interface RoutePreview {
  features: RequestFeatures;
  /** 本地可用性：false 时请求将直接走云端兜底。 */
  localAvailable: boolean;
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

  /**
   * 纯预览：返回统计特征与本地可用性。升级与否由本地模型生成时决定，
   * 发送前无法预知。
   */
  async preview(
    prompt: string,
    context: EditorContext = {},
    signal?: AbortSignal
  ): Promise<RoutePreview> {
    const features = classify(prompt, context, { weights: this.deps.options.weights });
    const localAvailable = this.deps.local
      ? await this.deps.local.isAvailable(signal)
      : false;
    return { features, localAvailable };
  }

  async route(
    prompt: string,
    context: EditorContext = {},
    signal?: AbortSignal
  ): Promise<RouteOutcome> {
    const startedAt = Date.now();
    const requestId = nextRequestId();
    const messages = buildMessages(prompt, context);
    const features = classify(prompt, context, { weights: this.deps.options.weights });

    let route: RouteKind = 'local';
    let escalation: EscalationRequest | undefined;
    let expertAnswer: string | undefined;
    let completion: CompletionResult;

    if (!this.deps.local) {
      // 未配置本地服务：等同本地不可用，整个请求走云端兜底。
      route = 'cloud';
      completion = await this.completeOnCloud(messages, signal);
    } else {
      try {
        const localResult = await this.deps.local.complete(
          messages,
          'chat-completions',
          signal,
          { escalate: this.deps.options.escalationEnabled }
        );
        const turn = parseLocalTurn(localResult.text);
        if (
          turn.kind === 'escalate' &&
          this.deps.options.escalationEnabled
        ) {
          escalation = turn.request;
          route = 'escalated';
          // 云端专家只回答子问题，不带原始完整上下文。
          expertAnswer = await this.askExpert(turn.request, signal);
          // 本地模型整合子问题答案，产出最终回复。
          completion = await this.synthesise(
            messages,
            turn.request,
            expertAnswer,
            signal
          );
        } else {
          if (turn.kind === 'escalate') {
            // 协议要求升级但升级被关闭：当作普通回答使用求助前的正文。
            completion = { ...localResult, text: turn.request.reason };
          } else {
            completion = { ...localResult, text: turn.text };
          }
        }
      } catch (error) {
        if (!this.deps.options.fallbackToCloud) {
          throw error;
        }
        route = 'cloud';
        completion = await this.completeOnCloud(messages, signal);
      }
    }

    const latencyMs = Date.now() - startedAt;

    await this.deps.ledger.record(route, features.estimatedTokens);
    await this.deps.journal?.recordDecision({
      requestId,
      predictedRoute: 'local',
      actualRoute: route,
      fallbackUsed: route === 'cloud',
      complexity: features.complexity,
      threshold: 0,
      tokenEstimate: features.estimatedTokens,
      latencyMs,
    });

    return {
      requestId,
      route,
      escalation,
      expertAnswer,
      features,
      completion,
      latencyMs,
    };
  }

  /** 云端专家回答本地模型拆出的子问题。失败时抛出，由外层降级到全云端。 */
  private async askExpert(
    request: EscalationRequest,
    signal?: AbortSignal
  ): Promise<string> {
    const messages: ChatMessage[] = [
      {
        role: 'system',
        content:
          'You are a remote expert assistant. A smaller local model asked you one focused question. Answer it precisely and concisely.',
      },
      { role: 'user', content: request.reason },
    ];
    const result = await this.completeOnCloud(messages, signal);
    return result.text;
  }

  /** 本地模型结合专家答案整合最终回复。 */
  private async synthesise(
    original: ChatMessage[],
    request: EscalationRequest,
    expertAnswer: string,
    signal?: AbortSignal
  ): Promise<CompletionResult> {
    if (!this.deps.local) {
      throw new LlmClientError('Local client disappeared mid-request');
    }
    const messages: ChatMessage[] = [
      ...original,
      {
        role: 'assistant',
        content: `[ESCALATE] ${request.reason}`,
      },
      {
        role: 'user',
        content: `A remote expert answered your sub-question:\n\n${expertAnswer}\n\nUsing this answer, give the final response to the original request in the user's language.`,
      },
    ];
    const result = await this.deps.local.complete(messages, 'chat-completions', signal);
    // 整合轮不该再求助；万一又输出标记，剥掉后仍返回正文。
    const turn = parseLocalTurn(result.text);
    return {
      ...result,
      text: turn.kind === 'answer' ? turn.text : turn.request.reason,
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
