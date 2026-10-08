import { afterEach, describe, expect, it, vi } from 'vitest';
import { CloudClient, LlmClientError } from './cloudClient';

/** 按 (url 含子串) 分发响应体的 fetch stub，并记录 Authorization 头。 */
function stubFetch(routes: Array<{ match: string; payload: unknown; status?: number }>) {
  const calls: Array<{ url: string; auth: string | undefined }> = [];
  vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
    const headers = (init.headers ?? {}) as Record<string, string>;
    calls.push({ url: String(url), auth: headers.Authorization });
    const route = routes.find((r) => url.includes(r.match));
    const status = route?.status ?? 200;
    const payload = route?.payload ?? {};
    return new Response(JSON.stringify(payload), {
      status,
      headers: { 'Content-Type': 'application/json' },
    });
  });
  return { calls };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

const options = (overrides: Partial<ConstructorParameters<typeof CloudClient>[0]> = {}) => ({
  baseUrl: 'https://api.openai.com/v1',
  apiKey: 'sk-test',
  model: 'gpt-4o-mini',
  ...overrides,
});

describe('CloudClient.isKeylessEndpoint', () => {
  it('本地 OpenAI 兼容端点（Ollama / llama.cpp）不需要 key', () => {
    for (const baseUrl of [
      'http://localhost:11434/v1',
      'http://127.0.0.1:8080',
      'http://0.0.0.0:11434/v1',
    ]) {
      expect(new CloudClient(options({ baseUrl })).isKeylessEndpoint).toBe(true);
    }
  });

  it('真实云端域名需要 key', () => {
    expect(new CloudClient(options()).isKeylessEndpoint).toBe(false);
  });

  it('无法解析的 URL 不视为本地端点', () => {
    expect(new CloudClient(options({ baseUrl: 'not-a-url' })).isKeylessEndpoint).toBe(false);
  });
});

describe('CloudClient.complete', () => {
  it('带 key 时发送 Authorization 头并解析答案', async () => {
    const stub = stubFetch([
      {
        match: '/chat/completions',
        payload: {
          model: 'gpt-4o-mini',
          choices: [{ message: { content: '42' } }],
          usage: { prompt_tokens: 3, completion_tokens: 1 },
        },
      },
    ]);
    const result = await new CloudClient(options()).complete([
      { role: 'user', content: '6*7' },
    ]);

    expect(result.text).toBe('42');
    expect(result.model).toBe('gpt-4o-mini');
    expect(result.promptTokens).toBe(3);
    expect(stub.calls[0].auth).toBe('Bearer sk-test');
  });

  it('本地端点无 key 也能调用，且不发送 Authorization 头', async () => {
    const stub = stubFetch([
      {
        match: '/chat/completions',
        payload: { model: 'qwen3', choices: [{ message: { content: 'ok' } }] },
      },
    ]);
    const client = new CloudClient(
      options({ baseUrl: 'http://localhost:11434/v1', apiKey: '', model: 'qwen3' })
    );

    const result = await client.complete([{ role: 'user', content: 'hi' }]);

    expect(result.text).toBe('ok');
    expect(stub.calls[0].auth).toBeUndefined();
  });

  it('云端域名无 key 时抛出带指引的错误', async () => {
    await expect(
      new CloudClient(options({ apiKey: '' })).complete([{ role: 'user', content: 'hi' }])
    ).rejects.toThrow(LlmClientError);
    await expect(
      new CloudClient(options({ apiKey: '' })).complete([{ role: 'user', content: 'hi' }])
    ).rejects.toThrow(/api key is empty/i);
  });

  it('响应缺少 choice 文本时抛错', async () => {
    stubFetch([{ match: '/chat/completions', payload: { choices: [] } }]);
    await expect(
      new CloudClient(options()).complete([{ role: 'user', content: 'hi' }])
    ).rejects.toThrow(/did not contain any choice text/);
  });

  it('HTTP 非 2xx 抛出带状态码的错误', async () => {
    stubFetch([{ match: '/chat/completions', payload: { error: 'bad key' }, status: 401 }]);
    await expect(
      new CloudClient(options()).complete([{ role: 'user', content: 'hi' }])
    ).rejects.toThrow(/HTTP 401/);
  });
});

describe('CloudClient.listModels', () => {
  it('解析 /models 返回的模型 id 列表', async () => {
    stubFetch([
      {
        match: '/models',
        payload: { data: [{ id: 'qwen3:4b' }, { id: 'llama3.2' }, { broken: true }] },
      },
    ]);
    const result = await new CloudClient(options()).listModels();

    expect(result.ok).toBe(true);
    expect(result.models).toEqual(['qwen3:4b', 'llama3.2']);
  });

  it('网络不可达时返回可读错误而不是抛异常', async () => {
    vi.stubGlobal(
      'fetch',
      async () => {
        throw new Error('fetch failed');
      }
    );
    const result = await new CloudClient(
      options({ baseUrl: 'http://localhost:11434/v1' })
    ).listModels();

    expect(result.ok).toBe(false);
    expect(result.models).toEqual([]);
    expect(result.error).toContain('fetch failed');
  });

  it('非 2xx 时返回带状态码的错误', async () => {
    stubFetch([{ match: '/models', payload: {}, status: 500 }]);
    const result = await new CloudClient(options()).listModels();

    expect(result.ok).toBe(false);
    expect(result.error).toContain('HTTP 500');
  });
});
