import { describe, it, expect } from 'bun:test';
import { OpenAIProvider } from './openai.ts';
import { getDescribeProvider } from './index.ts';
import { listProviderModels } from '../ai-providers.service.ts';
import { withTestEnv } from '../../test-support/env.test-helpers.ts';

const FRAME = [Buffer.alloc(4)];
const OPTS = { systemPrompt: 'p', model: 'qwen2.5-vl' };
const USAGE = { prompt_tokens: 1_000_000, completion_tokens: 1_000_000 };

function recordingFetch(): {
  fetchImpl: typeof fetch;
  calls: Array<{ url: string; auth: string }>;
} {
  const calls: Array<{ url: string; auth: string }> = [];
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    const headers = (init?.headers ?? {}) as Record<string, string>;
    calls.push({ url: String(url), auth: headers.authorization ?? '' });
    return new Response(
      JSON.stringify({
        choices: [{ message: { content: '{}' }, finish_reason: 'stop' }],
        usage: USAGE,
        data: [{ id: 'qwen2.5-vl' }],
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

describe('OpenAI provider base URL', () => {
  it('sends describe and health calls to a compatible server with the bearer key, unpriced', async () => {
    const { fetchImpl, calls } = recordingFetch();
    const provider = getDescribeProvider('openai', {
      url: 'http://192.168.0.23:8080/v1/',
      apiKey: 'sk-strata',
      fetchImpl,
    });
    await provider.health();
    const result = await provider.describe(FRAME, OPTS);
    expect(calls).toEqual([
      { url: 'http://192.168.0.23:8080/v1/models', auth: 'Bearer sk-strata' },
      { url: 'http://192.168.0.23:8080/v1/chat/completions', auth: 'Bearer sk-strata' },
    ]);
    expect(result.cost_usd).toBe(0);
  });

  it('keeps OpenAI and its rate card when the base URL is blank', async () => {
    const { fetchImpl, calls } = recordingFetch();
    const result = await new OpenAIProvider({ apiKey: 'k', baseUrl: ' ', fetchImpl }).describe(
      FRAME,
      { ...OPTS, model: 'gpt-4o-mini' },
    );
    expect(calls[0]!.url).toBe('https://api.openai.com/v1/chat/completions');
    expect(result.cost_usd).toBeCloseTo(0.75);
  });
});

describe('OpenAI base URL with a deployment key', () => {
  withTestEnv('MAPLE_OPENAI_API_KEY', 'environment-secret');

  it('never sends the deployment OpenAI key to a custom base URL', async () => {
    const { fetchImpl, calls } = recordingFetch();
    expect(() => getDescribeProvider('openai', { url: 'http://lan:8080/v1', fetchImpl })).toThrow(
      'custom base URL needs its own API key',
    );
    const realFetch = globalThis.fetch;
    globalThis.fetch = fetchImpl;
    try {
      const listed = await listProviderModels('openai', { url: 'http://lan:8080/v1' });
      expect(listed.source).toBe('fallback');
      expect(calls).toEqual([]);
      await getDescribeProvider('openai', { fetchImpl }).health();
      expect(calls).toEqual([
        { url: 'https://api.openai.com/v1/models', auth: 'Bearer environment-secret' },
      ]);
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});
