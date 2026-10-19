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
  timedProviderFetch,
  tokenUsageInfo,
  billedOutputText,
  type DescribeOptions,
  type DescribeProvider,
  type DescribeResult,
} from './index.ts';

const ENDPOINT = 'https://api.openai.com/v1/chat/completions';
const MODELS_ENDPOINT = 'https://api.openai.com/v1/models';
const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_OUTPUT_TOKENS = 2048;

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
  // fallow-ignore-next-line unused-class-member -- part of the DescribeProvider contract; callers use it through the interface
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
  // fallow-ignore-next-line unused-class-member -- part of the DescribeProvider contract; callers use it through the interface
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
      max_tokens: MAX_OUTPUT_TOKENS,
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

    const inTokens =
      typeof parsed.usage?.prompt_tokens === 'number' ? parsed.usage.prompt_tokens : 0;
    const outTokens =
      typeof parsed.usage?.completion_tokens === 'number' ? parsed.usage.completion_tokens : 0;
    const cost = priceForModel(opts.model, inTokens, outTokens);
    const text = billedOutputText(
      'OpenAI',
      cost,
      firstChoiceFinishReason(parsed.choices) === 'length'
        ? `finish_reason=length, max_tokens=${MAX_OUTPUT_TOKENS}`
        : null,
      () => extractFirstChoiceText(parsed.choices),
    );
    return {
      text,
      cost_usd: cost,
      provider_info: tokenUsageInfo(parsed.model, opts.model, inTokens, outTokens),
    };
  }

  private headers(): Record<string, string> {
    return { authorization: `Bearer ${this.apiKey}` };
  }

  private async timedFetch(url: string, init: RequestInit): Promise<Response> {
    return timedProviderFetch('OpenAI', url, init, {
      timeoutMs: this.timeoutMs,
      fetchImpl: this.fetchImpl,
    });
  }
}

function firstChoiceFinishReason(choices: unknown): unknown {
  const first = Array.isArray(choices) ? choices[0] : undefined;
  return first && typeof first === 'object'
    ? (first as { finish_reason?: unknown }).finish_reason
    : undefined;
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
