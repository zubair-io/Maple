/**
 * Anthropic Claude vision provider.
 *
 * POSTs to `/v1/messages` with the image as a base64 `image` content block.
 * Default model `claude-haiku-4-5`. Tracks input + output tokens; computes
 * cost from the published per-million-token rates in `PRICING`.
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

const ENDPOINT = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_VERSION = '2023-06-01';
const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_TOKENS = 256;

/**
 * Per-million-token USD pricing. Keep this in sync with
 * <https://www.anthropic.com/pricing> when models change. Unknown models
 * fall back to the Haiku rate to keep the spend cap honest (always
 * over-estimate when uncertain).
 *
 * The model id may be a versioned alias (`claude-haiku-4-5-20250101`); we
 * match by prefix so a date-suffixed alias picks up the same row.
 */
const PRICING: Array<{ prefix: string; in_per_m: number; out_per_m: number }> = [
  { prefix: 'claude-haiku-4', in_per_m: 1.0, out_per_m: 5.0 },
  { prefix: 'claude-haiku', in_per_m: 0.8, out_per_m: 4.0 },
  { prefix: 'claude-sonnet-4', in_per_m: 3.0, out_per_m: 15.0 },
  { prefix: 'claude-sonnet', in_per_m: 3.0, out_per_m: 15.0 },
  { prefix: 'claude-opus-4', in_per_m: 15.0, out_per_m: 75.0 },
  { prefix: 'claude-opus', in_per_m: 15.0, out_per_m: 75.0 },
];
const FALLBACK_RATE = { in_per_m: 1.0, out_per_m: 5.0 };

export interface AnthropicProviderConfig {
  apiKey: string;
  /** Per-call request timeout in milliseconds. Default 30_000. */
  requestTimeoutMs?: number;
  /** Test override. */
  fetchImpl?: typeof fetch;
}

interface AnthropicMessagesResponse {
  content?: unknown;
  model?: unknown;
  usage?: { input_tokens?: unknown; output_tokens?: unknown };
}

export class AnthropicProvider implements DescribeProvider {
  readonly name = 'anthropic' as const;

  private readonly apiKey: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(config: AnthropicProviderConfig) {
    this.apiKey = config.apiKey;
    this.timeoutMs = config.requestTimeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.fetchImpl = config.fetchImpl ?? fetch;
  }

  /** No dedicated health endpoint; do a tiny token-only message that
   * verifies the key works. We use a minimum max_tokens=1 to keep cost
   * effectively zero. */
  async health(): Promise<void> {
    const res = await this.timedFetch(ENDPOINT, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify({
        model: 'claude-haiku-4-5',
        max_tokens: 1,
        messages: [{ role: 'user', content: 'ping' }],
      }),
    });
    classifyHttp(res, 'Anthropic');
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
            ...jpegFrames.map((frame) => ({
              type: 'image',
              source: {
                type: 'base64',
                media_type: 'image/jpeg',
                data: frame.toString('base64'),
              },
            })),
            { type: 'text', text: opts.systemPrompt },
          ],
        },
      ],
    });
    const res = await this.timedFetch(ENDPOINT, {
      method: 'POST',
      headers: this.headers(),
      body,
    });
    classifyHttp(res, 'Anthropic');

    let parsed: AnthropicMessagesResponse;
    try {
      parsed = (await res.json()) as AnthropicMessagesResponse;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new RemoteError(`Malformed Anthropic JSON: ${msg}`, false);
    }

    const text = extractText(parsed.content);
    if (text.length === 0) {
      throw new RemoteError('Anthropic returned empty content', false);
    }
    const inTokens = typeof parsed.usage?.input_tokens === 'number' ? parsed.usage.input_tokens : 0;
    const outTokens =
      typeof parsed.usage?.output_tokens === 'number' ? parsed.usage.output_tokens : 0;
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
    return {
      'content-type': 'application/json',
      'x-api-key': this.apiKey,
      'anthropic-version': ANTHROPIC_VERSION,
    };
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
          ? `Anthropic request timed out after ${this.timeoutMs}ms`
          : `Anthropic request failed: ${msg}`,
        true,
      );
    } finally {
      clearTimeout(timer);
    }
  }
}

/** The Messages API returns `content: [{ type: "text", text: "..." }, ...]`.
 * Concatenate every text block; ignore non-text blocks. */
function extractText(content: unknown): string {
  if (!Array.isArray(content)) return '';
  const parts: string[] = [];
  for (const block of content) {
    if (
      block &&
      typeof block === 'object' &&
      'type' in block &&
      (block as { type: unknown }).type === 'text' &&
      'text' in block &&
      typeof (block as { text: unknown }).text === 'string'
    ) {
      parts.push((block as { text: string }).text);
    }
  }
  return parts.join('\n').trim();
}

function priceForModel(model: string, inTokens: number, outTokens: number): number {
  const row = PRICING.find((p) => model.startsWith(p.prefix)) ?? FALLBACK_RATE;
  const inUsd = (inTokens / 1_000_000) * row.in_per_m;
  const outUsd = (outTokens / 1_000_000) * row.out_per_m;
  return inUsd + outUsd;
}

function classifyHttp(res: Response, providerLabel: string): void {
  if (res.status >= 500) {
    throw new RemoteError(`${providerLabel} 5xx: ${res.status}`, true, res.status);
  }
  if (res.status >= 400) {
    throw new RemoteError(`${providerLabel} 4xx: ${res.status}`, false, res.status);
  }
}
