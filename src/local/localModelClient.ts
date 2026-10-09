/**
 * Infrastructure layer: talks to a locally running llama.cpp `llama-server`.
 *
 * Prefers the OpenAI-compatible `/v1/chat/completions` endpoint and can fall
 * back to the native `/completion` endpoint.
 */

import {
  ChatMessage,
  CompletionResult,
  LlmClientError,
  fetchWithTimeout,
  requireOk,
} from '../cloud/cloudClient';

export interface LocalModelClientOptions {
  serverUrl: string;
  /**
   * 模型名。llama.cpp 会忽略该字段，但 Ollama 的 OpenAI 兼容端点要求
   * 请求体必须携带 `model`，否则返回 400。
   */
  model?: string;
  /** Context window advertised to the server; must match the launched process. */
  contextTokens?: number;
  timeoutMs?: number;
}

export type LocalEndpoint = 'chat-completions' | 'completion';

/** 标记本地模型声明需要远程专家协助的协议前缀。 */
export const ESCALATE_MARKER = '[ESCALATE]';

/** 本地模型判断请求超出能力时，输出该结构求助；否则直接回答正文。 */
export const ESCALATION_SYSTEM_PROMPT =
  'You are a coding assistant running fully on the user\'s machine. ' +
  'If the request is simple and you can answer it correctly, answer directly in the user\'s language. ' +
  `If the task is complex (large refactor, architecture, cross-file changes, hard debugging), do NOT guess: reply with a single line starting with ${ESCALATE_MARKER} followed by ONE concise sub-question, phrased so a remote expert can answer it with minimal context. Do not output anything else after that line.`;

/** 本地模型如何声明一次求助及其子问题。 */
export interface EscalationRequest {
  reason: string;
}

/** 本地一次生成的解析结果：直接回答，或求助（含子问题）。 */
export type LocalTurn =
  | { kind: 'answer'; text: string }
  | { kind: 'escalate'; request: EscalationRequest };

/**
 * 解析本地输出：首个 ESCALATE 标记行之后的剩余内容视为子问题描述。
 * 标记前若已有实质正文，把它一并并入子问题描述，避免丢失上下文。
 */
export function parseLocalTurn(text: string): LocalTurn {
  const markerIndex = text.indexOf(ESCALATE_MARKER);
  if (markerIndex === -1) {
    return { kind: 'answer', text: text.trim() };
  }
  const before = text.slice(0, markerIndex).trim();
  const after = text.slice(markerIndex + ESCALATE_MARKER.length);
  const subQuestion = after.replace(/^[\s:：]+/, '').trim();
  if (subQuestion.length === 0 && before.length === 0) {
    // 空求助（只有标记没有内容）当作无效输出处理，与空答案同等对待。
    return { kind: 'answer', text: '' };
  }
  const reason = [before, subQuestion].filter((part) => part.length > 0).join('\n\n');
  return { kind: 'escalate', request: { reason } };
}

const DEFAULT_TIMEOUT_MS = 120_000;
export const DEFAULT_LOCAL_CONTEXT_TOKENS = 65536;

function flatten(messages: ChatMessage[]): string {
  return messages
    .map((message) => {
      const label =
        message.role === 'system'
          ? 'System'
          : message.role === 'assistant'
            ? 'Assistant'
            : 'User';
      return `${label}: ${message.content}`;
    })
    .join('\n\n');
}

export class LocalModelClient {
  private readonly serverUrl: string;
  readonly contextTokens: number;
  private readonly timeoutMs: number;
  private readonly model?: string;

  constructor(options: LocalModelClientOptions) {
    this.serverUrl = options.serverUrl.replace(/\/+$/, '');
    this.model = options.model;
    this.contextTokens = options.contextTokens ?? DEFAULT_LOCAL_CONTEXT_TOKENS;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  /**
   * Cheap liveness probe used before routing a request locally.
   *
   * llama.cpp exposes `/health`; Ollama does not (404), so fall back to
   * `GET /v1/models` when `/health` is missing. Any 2xx on either endpoint
   * means a usable OpenAI-compatible server is listening.
   */
  async isAvailable(signal?: AbortSignal): Promise<boolean> {
    const healthOk = await this.probe(`${this.serverUrl}/health`, signal);
    if (healthOk !== null) {
      return healthOk;
    }
    // /health 未命中（404/405）→ 可能是 Ollama，改探 /v1/models。
    return (await this.probe(`${this.serverUrl}/v1/models`, signal)) ?? false;
  }

  /** Returns true/false on a definitive answer, null when the path is absent. */
  private async probe(url: string, signal?: AbortSignal): Promise<boolean | null> {
    try {
      const response = await fetchWithTimeout(
        url,
        { method: 'GET' },
        2_000,
        signal
      );
      if (response.ok) {
        return true;
      }
      if (response.status === 404 || response.status === 405) {
        return null;
      }
      return false;
    } catch {
      return false;
    }
  }

  /**
   * 一次本地生成。`escalate` 为 true 时在 system 前附加升级协议，
   * 让本地模型可以声明 [ESCALATE] 求助；返回原始文本，由调用方用
   * {@link parseLocalTurn} 解析。
   */
  async complete(
    messages: ChatMessage[],
    endpoint: LocalEndpoint = 'chat-completions',
    signal?: AbortSignal,
    options: { escalate?: boolean } = {}
  ): Promise<CompletionResult> {
    const effective =
      options.escalate && messages.length > 0 && messages[0].role === 'system'
        ? [{ ...messages[0], content: `${ESCALATION_SYSTEM_PROMPT}\n\n${messages[0].content}` }, ...messages.slice(1)]
        : messages;
    return endpoint === 'completion'
      ? this.completeViaLegacyEndpoint(effective, signal)
      : this.completeViaChatEndpoint(effective, signal);
  }

  private async completeViaChatEndpoint(
    messages: ChatMessage[],
    signal?: AbortSignal
  ): Promise<CompletionResult> {
    // Qwen3 等支持「思考模式」的模型默认会先输出大段推理，token 全落在
    // reasoning_content 上，导致 choices[0].message.content 变成空字符串、
    // finish_reason=length。llama.cpp 读取请求体里的 chat_template_kwargs
    // 透传给 chat 模板，显式关闭 enable_thinking 才会直接产出正文。
    // 该字段对不支持思考模式的模型无害（模板会忽略未知 kwargs）。
    const body = JSON.stringify({
      // Ollama 的 OpenAI 兼容端点要求 model 字段；llama.cpp 忽略它。
      ...(this.model ? { model: this.model } : {}),
      messages,
      temperature: 0.2,
      stream: false,
      // 关闭思考后输出只是一份 JSON 文件计划，1024 个 token 足够容纳；此处
      // 不为了绕过空内容而盲目调大上限。
      max_tokens: 1024,
      chat_template_kwargs: { enable_thinking: false },
    });
    const response = await fetchWithTimeout(
      `${this.serverUrl}/v1/chat/completions`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
      },
      this.timeoutMs,
      signal
    );
    requireOk(response, 'Local chat completion');

    const payload = (await response.json()) as {
      model?: string;
      choices?: Array<{ message?: { content?: string } }>;
      usage?: { prompt_tokens?: number; completion_tokens?: number };
    };
    const text = payload.choices?.[0]?.message?.content;
    // 空字符串同样视为无效：思考模式下 content 可能为空、真正的推理落在
    // reasoning_content 里。思考内容不是可直接使用的答案，不得当作结果返回；
    // 这里抛出 LlmClientError，由上层编排器捕获并降级到云端/启发式。
    if (typeof text !== 'string' || text.trim().length === 0) {
      throw new LlmClientError('Local server returned no usable completion text');
    }
    return {
      text,
      model: payload.model ?? 'local-gguf',
      promptTokens: payload.usage?.prompt_tokens,
      completionTokens: payload.usage?.completion_tokens,
    };
  }

  private async completeViaLegacyEndpoint(
    messages: ChatMessage[],
    signal?: AbortSignal
  ): Promise<CompletionResult> {
    const body = JSON.stringify({
      prompt: flatten(messages),
      temperature: 0.2,
      stream: false,
      n_predict: 1024,
    });
    const response = await fetchWithTimeout(
      `${this.serverUrl}/completion`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
      },
      this.timeoutMs,
      signal
    );
    requireOk(response, 'Local legacy completion');

    const payload = (await response.json()) as {
      content?: string;
      model?: string;
      tokens_predicted?: number;
    };
    if (typeof payload.content !== 'string') {
      throw new LlmClientError('Local server returned no completion content');
    }
    return {
      text: payload.content,
      model: payload.model ?? 'local-gguf',
      completionTokens: payload.tokens_predicted,
    };
  }
}