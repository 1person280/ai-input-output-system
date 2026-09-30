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
  /** Context window advertised to the server; must match the launched process. */
  contextTokens?: number;
  timeoutMs?: number;
}

export type LocalEndpoint = 'chat-completions' | 'completion';

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

  constructor(options: LocalModelClientOptions) {
    this.serverUrl = options.serverUrl.replace(/\/+$/, '');
    this.contextTokens = options.contextTokens ?? DEFAULT_LOCAL_CONTEXT_TOKENS;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  /** Cheap liveness probe used before routing a request locally. */
  async isAvailable(signal?: AbortSignal): Promise<boolean> {
    try {
      const response = await fetchWithTimeout(
        `${this.serverUrl}/health`,
        { method: 'GET' },
        2_000,
        signal
      );
      return response.ok;
    } catch {
      return false;
    }
  }

  async complete(
    messages: ChatMessage[],
    endpoint: LocalEndpoint = 'chat-completions',
    signal?: AbortSignal
  ): Promise<CompletionResult> {
    return endpoint === 'completion'
      ? this.completeViaLegacyEndpoint(messages, signal)
      : this.completeViaChatEndpoint(messages, signal);
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