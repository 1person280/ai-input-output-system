import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ChatMessage } from '../cloud/cloudClient';
import { LocalModelClient } from './localModelClient';

const messages: ChatMessage[] = [{ role: 'user', content: '写一个 python 脚本' }];

/** 用假的 fetch 捕获请求体，并按给定 payload 返回一个 200 响应。 */
function stubFetch(payload: unknown): { getBody: () => Record<string, unknown> } {
  let body: Record<string, unknown> = {};
  vi.stubGlobal('fetch', async (_url: string, init: RequestInit) => {
    body = JSON.parse(String(init.body)) as Record<string, unknown>;
    return new Response(JSON.stringify(payload), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  });
  return { getBody: () => body };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('LocalModelClient.complete (chat-completions)', () => {
  it('关闭 Qwen3 思考模式：请求体带 chat_template_kwargs.enable_thinking=false', async () => {
    const fetchStub = stubFetch({
      model: 'qwen3',
      choices: [{ message: { content: '{"files":[]}' } }],
    });
    const client = new LocalModelClient({ serverUrl: 'http://127.0.0.1:8080' });

    await client.complete(messages, 'chat-completions');

    expect(fetchStub.getBody().chat_template_kwargs).toEqual({ enable_thinking: false });
  });

  it('content 为空时视为本地解答无效并抛错（不返回 reasoning_content）', async () => {
    vi.stubGlobal('fetch', async () =>
      new Response(
        JSON.stringify({
          choices: [
            {
              message: { content: '', reasoning_content: '让我想想……' },
              finish_reason: 'length',
            },
          ],
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      )
    );
    const client = new LocalModelClient({ serverUrl: 'http://127.0.0.1:8080' });

    await expect(client.complete(messages, 'chat-completions')).rejects.toThrow(
      /no usable completion text/
    );
  });
});