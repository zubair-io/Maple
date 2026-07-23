/**
 * OllamaProvider tests — mock the underlying `fetch` so CI never depends
 * on a real Ollama instance.
 */

import { describe, it, expect } from 'bun:test';
import { OllamaProvider } from './ollama.ts';
import type { RemoteError } from './index.ts';

interface MockResponse {
  status?: number;
  body?: unknown;
  delayMs?: number;
  failWith?: Error;
}

function mockFetch(responses: MockResponse[]): {
  fetchImpl: typeof fetch;
  calls: Array<{ url: string; init?: RequestInit }>;
} {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  let i = 0;
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    calls.push({ url, init });
    const r = responses[Math.min(i++, responses.length - 1)]!;
    if (r.failWith) throw r.failWith;
    if (r.delayMs && r.delayMs > 0) {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(resolve, r.delayMs);
        if (init?.signal) {
          if (init.signal.aborted) {
            clearTimeout(timer);
            reject(new DOMException('aborted', 'AbortError'));
          } else {
            init.signal.addEventListener('abort', () => {
              clearTimeout(timer);
              reject(new DOMException('aborted', 'AbortError'));
            });
          }
        }
      });
    }
    return new Response(JSON.stringify(r.body ?? {}), {
      status: r.status ?? 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

describe('OllamaProvider.health', () => {
  it('resolves on 200 from /api/tags', async () => {
    const { fetchImpl, calls } = mockFetch([{ status: 200, body: { models: [] } }]);
    const provider = new OllamaProvider({
      baseUrl: 'http://ollama.test',
      fetchImpl,
    });
    await provider.health();
    expect(calls[0]!.url).toBe('http://ollama.test/api/tags');
  });

  it('throws RemoteError on 5xx (non-retryable for health)', async () => {
    const { fetchImpl } = mockFetch([{ status: 503 }]);
    const provider = new OllamaProvider({
      baseUrl: 'http://ollama.test',
      fetchImpl,
    });
    await expect(provider.health()).rejects.toMatchObject({
      name: 'RemoteError',
      retryable: false,
      status: 503,
    });
  });

  it('strips trailing slash', async () => {
    const { fetchImpl, calls } = mockFetch([{ status: 200 }]);
    const provider = new OllamaProvider({
      baseUrl: 'http://ollama.test///',
      fetchImpl,
    });
    await provider.health();
    expect(calls[0]!.url).toBe('http://ollama.test/api/tags');
  });
});

describe('OllamaProvider.describe — happy path', () => {
  it('posts the base64 image and returns the trimmed caption', async () => {
    const { fetchImpl, calls } = mockFetch([
      {
        status: 200,
        body: {
          model: 'llava:latest',
          response: '  A red bicycle.\n',
          done: true,
          eval_count: 17,
          total_duration: 1_234_567_890,
        },
      },
    ]);
    const provider = new OllamaProvider({
      baseUrl: 'http://ollama.test',
      fetchImpl,
    });
    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);
    const result = await provider.describe(jpeg, {
      systemPrompt: 'describe this',
      model: 'llava:latest',
    });
    expect(result.text).toBe('A red bicycle.');
    expect(result.cost_usd).toBe(0);
    expect(result.provider_info.model).toBe('llava:latest');
    expect(result.provider_info.eval_count).toBe('17');
    expect(Number(result.provider_info.total_duration_ms)).toBeGreaterThan(0);

    expect(calls[0]!.url).toBe('http://ollama.test/api/generate');
    const body = JSON.parse(String(calls[0]!.init!.body));
    expect(body.model).toBe('llava:latest');
    expect(body.prompt).toBe('describe this');
    expect(Array.isArray(body.images)).toBe(true);
    expect(body.images[0]).toBe(jpeg.toString('base64'));
    expect(body.stream).toBe(false);
    // No `format` field when the caller doesn't supply one — back-compat
    // with older Ollama versions and free-text describe calls.
    expect('format' in body).toBe(false);
  });

  it('forwards a JSON Schema via the `format` field for structured output', async () => {
    const { fetchImpl, calls } = mockFetch([{ status: 200, body: { response: '{}', done: true } }]);
    const provider = new OllamaProvider({
      baseUrl: 'http://ollama.test',
      fetchImpl,
    });
    const schema = {
      type: 'object',
      properties: { caption: { type: 'string' } },
      required: ['caption'],
    };
    await provider.describe(Buffer.from([0xff, 0xd8]), {
      systemPrompt: 'p',
      model: 'qwen3-vl:8b',
      format: schema,
    });
    const body = JSON.parse(String(calls[0]!.init!.body));
    expect(body.format).toEqual(schema);
  });
});

describe('OllamaProvider.describe — failure modes', () => {
  it('classifies 5xx as retryable', async () => {
    const { fetchImpl } = mockFetch([{ status: 502 }]);
    const provider = new OllamaProvider({
      baseUrl: 'http://ollama.test',
      fetchImpl,
    });
    let caught: RemoteError | null = null;
    try {
      await provider.describe(Buffer.alloc(4), {
        systemPrompt: 'p',
        model: 'llava:latest',
      });
    } catch (e) {
      caught = e as RemoteError;
    }
    expect(caught).toBeTruthy();
    expect(caught!.retryable).toBe(true);
    expect(caught!.status).toBe(502);
  });

  it('classifies 4xx as non-retryable', async () => {
    const { fetchImpl } = mockFetch([{ status: 400 }]);
    const provider = new OllamaProvider({
      baseUrl: 'http://ollama.test',
      fetchImpl,
    });
    let caught: RemoteError | null = null;
    try {
      await provider.describe(Buffer.alloc(4), {
        systemPrompt: 'p',
        model: 'llava:latest',
      });
    } catch (e) {
      caught = e as RemoteError;
    }
    expect(caught!.retryable).toBe(false);
    expect(caught!.status).toBe(400);
  });

  it('times out a slow response and surfaces a retryable error', async () => {
    const { fetchImpl } = mockFetch([{ status: 200, body: {}, delayMs: 5_000 }]);
    const provider = new OllamaProvider({
      baseUrl: 'http://ollama.test',
      fetchImpl,
      requestTimeoutMs: 50,
    });
    let caught: RemoteError | null = null;
    try {
      await provider.describe(Buffer.alloc(4), {
        systemPrompt: 'p',
        model: 'llava:latest',
      });
    } catch (e) {
      caught = e as RemoteError;
    }
    expect(caught).toBeTruthy();
    expect(caught!.retryable).toBe(true);
    expect(caught!.message).toMatch(/timed out/);
  });

  it('rejects an empty response as retryable — empties are transient (#2172)', async () => {
    const { fetchImpl } = mockFetch([{ status: 200, body: { response: '   ' } }]);
    const provider = new OllamaProvider({
      baseUrl: 'http://ollama.test',
      fetchImpl,
    });
    let caught: RemoteError | null = null;
    try {
      await provider.describe(Buffer.alloc(4), {
        systemPrompt: 'p',
        model: 'llava:latest',
      });
    } catch (e) {
      caught = e as RemoteError;
    }
    expect(caught).toBeTruthy();
    expect(caught!.retryable).toBe(true);
  });

  it('stamps structured diagnostics into the empty-response error (#2172)', async () => {
    const { fetchImpl } = mockFetch([
      {
        status: 200,
        body: {
          model: 'qwen3-vl:8b',
          response: '',
          done: true,
          done_reason: 'load',
          eval_count: 0,
          total_duration: 42_000_000, // ns → 42 ms
        },
      },
    ]);
    const provider = new OllamaProvider({
      baseUrl: 'http://ollama.test',
      fetchImpl,
    });
    let caught: RemoteError | null = null;
    try {
      await provider.describe(Buffer.alloc(4), {
        systemPrompt: 'secret prompt content',
        model: 'llava:latest',
      });
    } catch (e) {
      caught = e as RemoteError;
    }
    expect(caught).toBeTruthy();
    // Operator-facing last_error must identify the provider state without
    // leaking prompt content.
    expect(caught!.message).toContain('Ollama returned empty response');
    expect(caught!.message).toContain('model=qwen3-vl:8b');
    expect(caught!.message).toContain('http=200');
    expect(caught!.message).toContain('done=true');
    expect(caught!.message).toContain('done_reason=load');
    expect(caught!.message).toContain('eval_count=0');
    expect(caught!.message).toContain('total_duration_ms=42');
    expect(caught!.message).not.toContain('secret prompt content');
    expect(caught!.status).toBe(200);
  });

  it('falls back to the requested model + unknown markers when the body is bare (#2172)', async () => {
    const { fetchImpl } = mockFetch([{ status: 200, body: { response: '' } }]);
    const provider = new OllamaProvider({
      baseUrl: 'http://ollama.test',
      fetchImpl,
    });
    let caught: RemoteError | null = null;
    try {
      await provider.describe(Buffer.alloc(4), {
        systemPrompt: 'p',
        model: 'llava:latest',
      });
    } catch (e) {
      caught = e as RemoteError;
    }
    expect(caught).toBeTruthy();
    expect(caught!.message).toContain('model=llava:latest');
    expect(caught!.message).toContain('done=unknown');
    expect(caught!.message).toContain('done_reason=unknown');
  });

  it('recovers schema-constrained output misrouted into `thinking` (#2172)', async () => {
    // qwen3-vl under a `format` JSON-schema constraint cannot emit its
    // </think> terminator, so Ollama (observed on 0.30.11) classifies the
    // whole constrained output as thinking and returns response: "".
    const visionJson = '{"is_screenshot":false,"caption":"tree bark with lichen"}';
    const { fetchImpl } = mockFetch([
      {
        status: 200,
        body: {
          model: 'qwen3-vl:8b',
          response: '',
          thinking: visionJson,
          done: true,
          done_reason: 'stop',
          eval_count: 152,
        },
      },
    ]);
    const provider = new OllamaProvider({
      baseUrl: 'http://ollama.test',
      fetchImpl,
    });
    const result = await provider.describe(Buffer.alloc(4), {
      systemPrompt: 'p',
      model: 'qwen3-vl:8b',
    });
    expect(result.text).toBe(visionJson);
  });

  it('prefers `response` over `thinking` when both are present', async () => {
    const { fetchImpl } = mockFetch([
      {
        status: 200,
        body: { response: '{"caption":"answer"}', thinking: 'internal reasoning', done: true },
      },
    ]);
    const provider = new OllamaProvider({
      baseUrl: 'http://ollama.test',
      fetchImpl,
    });
    const result = await provider.describe(Buffer.alloc(4), {
      systemPrompt: 'p',
      model: 'qwen3-vl:8b',
    });
    expect(result.text).toBe('{"caption":"answer"}');
  });

  it('reports thinking_chars in the empty-response diagnostics (#2172)', async () => {
    const { fetchImpl } = mockFetch([
      { status: 200, body: { response: '', thinking: '', done: true, done_reason: 'stop' } },
    ]);
    const provider = new OllamaProvider({
      baseUrl: 'http://ollama.test',
      fetchImpl,
    });
    let caught: RemoteError | null = null;
    try {
      await provider.describe(Buffer.alloc(4), { systemPrompt: 'p', model: 'qwen3-vl:8b' });
    } catch (e) {
      caught = e as RemoteError;
    }
    expect(caught).toBeTruthy();
    expect(caught!.message).toContain('thinking_chars=0');
  });

  it('recovers when an empty response is followed by a successful retry (#2172)', async () => {
    const { fetchImpl } = mockFetch([
      { status: 200, body: { response: '', done: true, done_reason: 'load' } },
      { status: 200, body: { model: 'qwen3-vl:8b', response: '{"caption":"ok"}', done: true } },
    ]);
    const provider = new OllamaProvider({
      baseUrl: 'http://ollama.test',
      fetchImpl,
    });
    const opts = { systemPrompt: 'p', model: 'qwen3-vl:8b' };
    let first: RemoteError | null = null;
    try {
      await provider.describe(Buffer.alloc(4), opts);
    } catch (e) {
      first = e as RemoteError;
    }
    expect(first!.retryable).toBe(true);
    const second = await provider.describe(Buffer.alloc(4), opts);
    expect(second.text).toBe('{"caption":"ok"}');
  });
});
