/**
 * AnthropicProvider tests — proves the paid-provider pattern shared across
 * OpenAI/Gemini. We don't ship per-paid-provider tests because the only
 * differences between them are URL/payload/pricing tables; the failure
 * classification, timeout, and key-handling logic is shared.
 */

import { describe, it, expect } from 'bun:test';
import { AnthropicProvider } from './anthropic.ts';
import type { RemoteError } from './index.ts';

interface MockResponse {
  status?: number;
  body?: unknown;
  delayMs?: number;
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
    if (r.delayMs && r.delayMs > 0) {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(resolve, r.delayMs);
        if (init?.signal) {
          init.signal.addEventListener('abort', () => {
            clearTimeout(timer);
            reject(new DOMException('aborted', 'AbortError'));
          });
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

describe('AnthropicProvider.describe — happy path', () => {
  it('posts the image as a base64 image block and returns the caption + cost', async () => {
    const { fetchImpl, calls } = mockFetch([
      {
        status: 200,
        body: {
          model: 'claude-haiku-4-5',
          content: [{ type: 'text', text: 'A red bicycle.' }],
          usage: { input_tokens: 1000, output_tokens: 100 },
        },
      },
    ]);
    const provider = new AnthropicProvider({
      apiKey: 'test-key',
      fetchImpl,
    });
    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);
    const result = await provider.describe(jpeg, {
      systemPrompt: 'describe',
      model: 'claude-haiku-4-5',
    });
    expect(result.text).toBe('A red bicycle.');
    expect(result.provider_info.input_tokens).toBe('1000');
    expect(result.provider_info.output_tokens).toBe('100');
    // 1k input @ $1/M + 100 output @ $5/M = 0.001 + 0.0005 = 0.0015
    expect(result.cost_usd).toBeCloseTo(0.0015, 6);

    expect(calls[0]!.url).toBe('https://api.anthropic.com/v1/messages');
    const headers = calls[0]!.init!.headers as Record<string, string>;
    expect(headers['x-api-key']).toBe('test-key');
    expect(headers['anthropic-version']).toBe('2023-06-01');
    const body = JSON.parse(String(calls[0]!.init!.body));
    expect(body.model).toBe('claude-haiku-4-5');
    const content = body.messages[0].content;
    expect(content[0].type).toBe('image');
    expect(content[0].source.media_type).toBe('image/jpeg');
    expect(content[0].source.data).toBe(jpeg.toString('base64'));
    expect(content[1].type).toBe('text');
    expect(content[1].text).toBe('describe');
  });
});

describe('AnthropicProvider.describe — failure modes', () => {
  it('classifies 5xx as retryable', async () => {
    const { fetchImpl } = mockFetch([{ status: 503 }]);
    const provider = new AnthropicProvider({
      apiKey: 'test-key',
      fetchImpl,
    });
    let caught: RemoteError | null = null;
    try {
      await provider.describe(Buffer.alloc(4), {
        systemPrompt: 'p',
        model: 'claude-haiku-4-5',
      });
    } catch (e) {
      caught = e as RemoteError;
    }
    expect(caught).toBeTruthy();
    expect(caught!.retryable).toBe(true);
    expect(caught!.status).toBe(503);
  });

  it('classifies 4xx as non-retryable', async () => {
    const { fetchImpl } = mockFetch([{ status: 401 }]);
    const provider = new AnthropicProvider({
      apiKey: 'bad-key',
      fetchImpl,
    });
    let caught: RemoteError | null = null;
    try {
      await provider.describe(Buffer.alloc(4), {
        systemPrompt: 'p',
        model: 'claude-haiku-4-5',
      });
    } catch (e) {
      caught = e as RemoteError;
    }
    expect(caught!.retryable).toBe(false);
    expect(caught!.status).toBe(401);
  });

  it('times out a slow response and surfaces a retryable error', async () => {
    const { fetchImpl } = mockFetch([{ status: 200, body: {}, delayMs: 5_000 }]);
    const provider = new AnthropicProvider({
      apiKey: 'test-key',
      fetchImpl,
      requestTimeoutMs: 50,
    });
    let caught: RemoteError | null = null;
    try {
      await provider.describe(Buffer.alloc(4), {
        systemPrompt: 'p',
        model: 'claude-haiku-4-5',
      });
    } catch (e) {
      caught = e as RemoteError;
    }
    expect(caught).toBeTruthy();
    expect(caught!.retryable).toBe(true);
    expect(caught!.message).toMatch(/timed out/);
  });
});
