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

describe('LocalModelClient.isAvailable', () => {
  it('llama.cpp：/health 200 即可用，不再探测其他端点', async () => {
    const probed: string[] = [];
    vi.stubGlobal('fetch', async (url: string) => {
      probed.push(String(url));
      return new Response('OK', { status: 200 });
    });
    const client = new LocalModelClient({ serverUrl: 'http://127.0.0.1:8080' });

    await expect(client.isAvailable()).resolves.toBe(true);
    expect(probed).toHaveLength(1);
    expect(probed[0]).toContain('/health');
  });

  it('Ollama：/health 404 时回退探测 /v1/models，200 判为可用', async () => {
    const probed: string[] = [];
    vi.stubGlobal('fetch', async (url: string) => {
      probed.push(String(url));
      if (String(url).includes('/health')) {
        return new Response('404', { status: 404 });
      }
      return new Response(JSON.stringify({ data: [{ id: 'qwen2.5:0.5b' }] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    });
    const client = new LocalModelClient({ serverUrl: 'http://127.0.0.1:11434' });

    await expect(client.isAvailable()).resolves.toBe(true);
    expect(probed).toHaveLength(2);
    expect(probed[1]).toContain('/v1/models');
  });

  it('两个端点都不可达时判为不可用', async () => {
    vi.stubGlobal('fetch', async () => {
      throw new Error('fetch failed');
    });
    const client = new LocalModelClient({ serverUrl: 'http://127.0.0.1:11434' });

    await expect(client.isAvailable()).resolves.toBe(false);
  });

  it('两个端点都返回 404 时判为不可用', async () => {
    vi.stubGlobal('fetch', async () => new Response('404', { status: 404 }));
    const client = new LocalModelClient({ serverUrl: 'http://127.0.0.1:11434' });

    await expect(client.isAvailable()).resolves.toBe(false);
  });
});