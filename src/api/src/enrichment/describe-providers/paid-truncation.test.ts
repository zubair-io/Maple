import { describe, it, expect } from 'bun:test';
import { AnthropicProvider } from './anthropic.ts';
import { GeminiProvider } from './gemini.ts';
import { OpenAIProvider } from './openai.ts';
import { RemoteError, type TruncatedOutputError } from './index.ts';

const FRAME = [Buffer.alloc(4)];
const OPTS = { systemPrompt: 'p', model: 'm' };
const CUT_OFF = '{"is_screenshot": true, "caption": "A terminal window showing';

function jsonFetch(body: unknown): { fetchImpl: typeof fetch; requests: string[] } {
  const requests: string[] = [];
  const fetchImpl = (async (_url: string | URL | Request, init?: RequestInit) => {
    requests.push(String(init?.body));
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as unknown as typeof fetch;
  return { fetchImpl, requests };
}

async function failure(run: () => Promise<unknown>): Promise<RemoteError> {
  try {
    await run();
  } catch (err) {
    return err as RemoteError;
  }
  throw new Error('expected describe to throw');
}

describe('paid describe providers: output budget', () => {
  it('OpenAI requests enough tokens for a full VisionDoc', async () => {
    const { fetchImpl, requests } = jsonFetch({
      choices: [{ message: { content: '{}' }, finish_reason: 'stop' }],
    });
    await new OpenAIProvider({ apiKey: 'k', fetchImpl }).describe(FRAME, OPTS);
    expect(JSON.parse(requests[0]!).max_tokens).toBeGreaterThanOrEqual(2048);
  });

  it('Anthropic requests enough tokens for a full VisionDoc', async () => {
    const { fetchImpl, requests } = jsonFetch({
      content: [{ type: 'text', text: '{}' }],
      stop_reason: 'end_turn',
    });
    await new AnthropicProvider({ apiKey: 'k', fetchImpl }).describe(FRAME, OPTS);
    expect(JSON.parse(requests[0]!).max_tokens).toBeGreaterThanOrEqual(2048);
  });

  it('Gemini leaves headroom for thinking tokens', async () => {
    const { fetchImpl, requests } = jsonFetch({
      candidates: [{ content: { parts: [{ text: '{}' }] }, finishReason: 'STOP' }],
    });
    await new GeminiProvider({ apiKey: 'k', fetchImpl }).describe(FRAME, OPTS);
    expect(JSON.parse(requests[0]!).generationConfig.maxOutputTokens).toBeGreaterThanOrEqual(8192);
  });
});

describe('paid describe providers: truncation', () => {
  it.each([
    [OpenAIProvider, { choices: [], usage: { prompt_tokens: 900, completion_tokens: 20 } }],
    [AnthropicProvider, { content: [], usage: { input_tokens: 900, output_tokens: 20 } }],
    [
      GeminiProvider,
      { candidates: [], usageMetadata: { promptTokenCount: 900, thoughtsTokenCount: 20 } },
    ],
  ] as const)('retains billed usage when %p returns empty content', async (Provider, body) => {
    const { fetchImpl } = jsonFetch(body);
    const err = await failure(() => new Provider({ apiKey: 'k', fetchImpl }).describe(FRAME, OPTS));
    expect(err.message).toContain('empty content');
    expect(err.retryable).toBe(false);
    expect((err as TruncatedOutputError).cost_usd).toBeGreaterThan(0);
  });

  it('OpenAI finish_reason=length is a non-retryable OpenAI error', async () => {
    const { fetchImpl } = jsonFetch({
      model: 'gpt-4o-mini',
      choices: [{ message: { content: CUT_OFF }, finish_reason: 'length' }],
      usage: { prompt_tokens: 900, completion_tokens: 2048 },
    });
    const err = await failure(() =>
      new OpenAIProvider({ apiKey: 'k', fetchImpl }).describe(FRAME, OPTS),
    );
    expect(err).toBeInstanceOf(RemoteError);
    expect(err.retryable).toBe(false);
    expect(err.message).toContain('OpenAI');
    expect(err.message).toContain('finish_reason=length');
    expect((err as TruncatedOutputError).cost_usd).toBeGreaterThan(0);
  });

  it('Anthropic stop_reason=max_tokens is a non-retryable Anthropic error', async () => {
    const { fetchImpl } = jsonFetch({
      model: 'claude-haiku-4-5',
      content: [{ type: 'text', text: CUT_OFF }],
      stop_reason: 'max_tokens',
      usage: { input_tokens: 900, output_tokens: 2048 },
    });
    const err = await failure(() =>
      new AnthropicProvider({ apiKey: 'k', fetchImpl }).describe(FRAME, OPTS),
    );
    expect(err.retryable).toBe(false);
    expect(err.message).toContain('Anthropic');
    expect(err.message).toContain('stop_reason=max_tokens');
  });

  it('Gemini finishReason=MAX_TOKENS with partial text is a non-retryable Gemini error', async () => {
    const { fetchImpl } = jsonFetch({
      candidates: [{ content: { parts: [{ text: CUT_OFF }] }, finishReason: 'MAX_TOKENS' }],
    });
    const err = await failure(() =>
      new GeminiProvider({ apiKey: 'k', fetchImpl }).describe(FRAME, OPTS),
    );
    expect(err.retryable).toBe(false);
    expect(err.message).toContain('Gemini');
    expect(err.message).toContain('finishReason=MAX_TOKENS');
  });

  it('Gemini MAX_TOKENS with no text (thinking ate the budget) names the truncation, not empty content', async () => {
    const { fetchImpl } = jsonFetch({
      candidates: [{ content: { role: 'model' }, finishReason: 'MAX_TOKENS' }],
      usageMetadata: { promptTokenCount: 900, thoughtsTokenCount: 8000 },
    });
    const err = await failure(() =>
      new GeminiProvider({ apiKey: 'k', fetchImpl }).describe(FRAME, OPTS),
    );
    expect(err.retryable).toBe(false);
    expect(err.message).toContain('finishReason=MAX_TOKENS');
  });

  it('Gemini bills thought tokens as output on a successful response', async () => {
    const { fetchImpl } = jsonFetch({
      candidates: [{ content: { parts: [{ text: '{}' }] }, finishReason: 'STOP' }],
      usageMetadata: { promptTokenCount: 0, candidatesTokenCount: 1000, thoughtsTokenCount: 3000 },
    });
    const result = await new GeminiProvider({ apiKey: 'k', fetchImpl }).describe(FRAME, OPTS);
    const withoutThoughts = await new GeminiProvider({
      apiKey: 'k',
      fetchImpl: jsonFetch({
        candidates: [{ content: { parts: [{ text: '{}' }] }, finishReason: 'STOP' }],
        usageMetadata: { promptTokenCount: 0, candidatesTokenCount: 1000 },
      }).fetchImpl,
    }).describe(FRAME, OPTS);
    expect(result.cost_usd).toBeCloseTo(withoutThoughts.cost_usd * 4, 10);
  });
});
