/**
 * OpenAI vision provider.
 *
 * Posts to `/v1/chat/completions` with the image as an `image_url` content
 * part (data-URI base64). Default model `gpt-4o-mini`. Tracks input + output
 * tokens; computes cost from the published per-million-token rates.
 *
 * Spec: `docs/indexer-enrichment.md` §6.
 */

import {
  RemoteError,
  requireFrames,
  type DescribeOptions,
  type DescribeProvider,
  type DescribeResult,
} from './index.ts';

const ENDPOINT = 'https://api.openai.com/v1/chat/completions';
const MODELS_ENDPOINT = 'https://api.openai.com/v1/models';
const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_TOKENS = 256;

/**
 * Per-million-token USD pricing. Match by prefix so versioned aliases (e.g.
 * `gpt-4o-mini-2024-07-18`) pick up the same row. Unknown models fall back
 * to gpt-4o-mini rates.
 */
const PRICING: Array<{ prefix: string; in_per_m: number; out_per_m: number }> = [
  { prefix: 'gpt-4o-mini', in_per_m: 0.15, out_per_m: 0.6 },
  { prefix: 'gpt-4o', in_per_m: 2.5, out_per_m: 10.0 },
  { prefix: 'gpt-4-turbo', in_per_m: 10.0, out_per_m: 30.0 },
];
const FALLBACK_RATE = { in_per_m: 0.15, out_per_m: 0.6 };

export interface OpenAIProviderConfig {
  apiKey: string;
  /** Per-call request timeout in milliseconds. Default 30_000. */
  requestTimeoutMs?: number;
  /** Test override. */
  fetchImpl?: typeof fetch;
}

interface OpenAIChatResponse {
  choices?: unknown;
  model?: unknown;
  usage?: { prompt_tokens?: unknown; completion_tokens?: unknown };
}

export class OpenAIProvider implements DescribeProvider {
  readonly name = 'openai' as const;

  private readonly apiKey: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(config: OpenAIProviderConfig) {
    this.apiKey = config.apiKey;
    this.timeoutMs = config.requestTimeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.fetchImpl = config.fetchImpl ?? fetch;
  }

  /** GET `/v1/models` — verifies the key works without spending tokens. */
  async health(): Promise<void> {
    const res = await this.timedFetch(MODELS_ENDPOINT, {
      method: 'GET',
      headers: this.headers(),
    });
    classifyHttp(res, 'OpenAI');
  }

  async describe(jpegFrames: readonly Buffer[], opts: DescribeOptions): Promise<DescribeResult> {
    requireFrames(jpegFrames);
    const body = JSON.stringify({
      model: opts.model,
      max_tokens: DEFAULT_MAX_TOKENS,
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: opts.systemPrompt },
            ...jpegFrames.map((frame) => ({
              type: 'image_url',
              image_url: {
                url: `data:image/jpeg;base64,${frame.toString('base64')}`,
              },
            })),
          ],
        },
      ],
    });
    const res = await this.timedFetch(ENDPOINT, {
      method: 'POST',
      headers: { ...this.headers(), 'content-type': 'application/json' },
      body,
    });
    classifyHttp(res, 'OpenAI');

    let parsed: OpenAIChatResponse;
    try {
      parsed = (await res.json()) as OpenAIChatResponse;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new RemoteError(`Malformed OpenAI JSON: ${msg}`, false);
    }

    const text = extractFirstChoiceText(parsed.choices);
    if (text.length === 0) {
      throw new RemoteError('OpenAI returned empty content', false);
    }
    const inTokens =
      typeof parsed.usage?.prompt_tokens === 'number' ? parsed.usage.prompt_tokens : 0;
    const outTokens =
      typeof parsed.usage?.completion_tokens === 'number' ? parsed.usage.completion_tokens : 0;
    const cost = priceForModel(opts.model, inTokens, outTokens);
    return {
      text,
      cost_usd: cost,
      provider_info: {
        model: typeof parsed.model === 'string' ? parsed.model : opts.model,
        input_tokens: String(inTokens),
        output_tokens: String(outTokens),
      },
    };
  }

  private headers(): Record<string, string> {
    return { authorization: `Bearer ${this.apiKey}` };
  }

  private async timedFetch(url: string, init: RequestInit): Promise<Response> {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.timeoutMs);
    try {
      return await this.fetchImpl(url, { ...init, signal: ctrl.signal });
    } catch (err) {
      const aborted = err instanceof Error && (err.name === 'AbortError' || ctrl.signal.aborted);
      const msg = err instanceof Error ? err.message : String(err);
      throw new RemoteError(
        aborted
          ? `OpenAI request timed out after ${this.timeoutMs}ms`
          : `OpenAI request failed: ${msg}`,
        true,
      );
    } finally {
      clearTimeout(timer);
    }
  }
}

function extractFirstChoiceText(choices: unknown): string {
  if (!Array.isArray(choices) || choices.length === 0) return '';
  const first = choices[0];
  if (
    !first ||
    typeof first !== 'object' ||
    !('message' in first) ||
    typeof (first as { message: unknown }).message !== 'object' ||
    (first as { message: unknown }).message === null
  ) {
    return '';
  }
  const msg = (first as { message: { content?: unknown } }).message;
  if (typeof msg.content === 'string') return msg.content.trim();
  return '';
}

function priceForModel(model: string, inTokens: number, outTokens: number): number {
  const row = PRICING.find((p) => model.startsWith(p.prefix)) ?? FALLBACK_RATE;
  return (inTokens / 1_000_000) * row.in_per_m + (outTokens / 1_000_000) * row.out_per_m;
}

function classifyHttp(res: Response, providerLabel: string): void {
  if (res.status >= 500) {
    throw new RemoteError(`${providerLabel} 5xx: ${res.status}`, true, res.status);
  }
  if (res.status >= 400) {
    throw new RemoteError(`${providerLabel} 4xx: ${res.status}`, false, res.status);
  }
}
