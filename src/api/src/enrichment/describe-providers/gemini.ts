/**
 * Google Gemini vision provider.
 *
 * POSTs to `/v1beta/models/${model}:generateContent` with the image as an
 * inline base64 part. Default model `gemini-flash`. Gemini bills by *char*
 * on input (not tokens) — `usage_metadata.prompt_token_count` is reported
 * in tokens, but the published price table is per char-million; we
 * approximate using the reported token counts and the published per-million
 * rates so the spend cap is conservative.
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

const ENDPOINT_BASE = 'https://generativelanguage.googleapis.com/v1beta/models';
const MODELS_ENDPOINT = 'https://generativelanguage.googleapis.com/v1beta/models';
const DEFAULT_TIMEOUT_MS = 30_000;
// Thinking tokens count against maxOutputTokens, so this leaves room for them on top of the JSON.
const MAX_OUTPUT_TOKENS = 8192;

/**
 * Per-million-char USD pricing (Gemini's public rate sheet uses
 * characters; we treat reported token counts as a conservative
 * approximation — overestimates cost slightly so the daily cap stays
 * honest).
 */
const PRICING: Array<{ prefix: string; in_per_m: number; out_per_m: number }> = [
  { prefix: 'gemini-flash', in_per_m: 0.075, out_per_m: 0.3 },
  { prefix: 'gemini-1.5-flash', in_per_m: 0.075, out_per_m: 0.3 },
  { prefix: 'gemini-1.5-pro', in_per_m: 1.25, out_per_m: 5.0 },
  { prefix: 'gemini-pro', in_per_m: 1.25, out_per_m: 5.0 },
];
const FALLBACK_RATE = { in_per_m: 0.075, out_per_m: 0.3 };

export interface GeminiProviderConfig {
  apiKey: string;
  /** Per-call request timeout in milliseconds. Default 30_000. */
  requestTimeoutMs?: number;
  /** Test override. */
  fetchImpl?: typeof fetch;
}

interface GeminiResponse {
  candidates?: unknown;
  modelVersion?: unknown;
  usageMetadata?: {
    promptTokenCount?: unknown;
    candidatesTokenCount?: unknown;
    thoughtsTokenCount?: unknown;
  };
}

export class GeminiProvider implements DescribeProvider {
  // fallow-ignore-next-line unused-class-member -- part of the DescribeProvider contract; callers use it through the interface
  readonly name = 'gemini' as const;

  private readonly apiKey: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(config: GeminiProviderConfig) {
    this.apiKey = config.apiKey;
    this.timeoutMs = config.requestTimeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.fetchImpl = config.fetchImpl ?? fetch;
  }

  /** GET `/v1beta/models?key=...` — verifies the key works. */
  // fallow-ignore-next-line unused-class-member -- part of the DescribeProvider contract; callers use it through the interface
  async health(): Promise<void> {
    const url = `${MODELS_ENDPOINT}?key=${encodeURIComponent(this.apiKey)}`;
    const res = await this.timedFetch(url, { method: 'GET' });
    classifyHttp(res, 'Gemini');
  }

  async describe(jpegFrames: readonly Buffer[], opts: DescribeOptions): Promise<DescribeResult> {
    requireFrames(jpegFrames);
    const url = `${ENDPOINT_BASE}/${encodeURIComponent(opts.model)}:generateContent?key=${encodeURIComponent(this.apiKey)}`;
    const body = JSON.stringify({
      contents: [
        {
          role: 'user',
          parts: [
            ...jpegFrames.map((frame) => ({
              inline_data: {
                mime_type: 'image/jpeg',
                data: frame.toString('base64'),
              },
            })),
            { text: opts.systemPrompt },
          ],
        },
      ],
      generationConfig: { maxOutputTokens: MAX_OUTPUT_TOKENS },
    });
    const res = await this.timedFetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body,
    });
    classifyHttp(res, 'Gemini');

    let parsed: GeminiResponse;
    try {
      parsed = (await res.json()) as GeminiResponse;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new RemoteError(`Malformed Gemini JSON: ${msg}`, false);
    }

    const inTokens = tokenCount(parsed.usageMetadata?.promptTokenCount);
    const outTokens =
      tokenCount(parsed.usageMetadata?.candidatesTokenCount) +
      tokenCount(parsed.usageMetadata?.thoughtsTokenCount);
    const cost = priceForModel(opts.model, inTokens, outTokens);
    const text = billedOutputText(
      'Gemini',
      cost,
      firstCandidateFinishReason(parsed.candidates) === 'MAX_TOKENS'
        ? `finishReason=MAX_TOKENS, maxOutputTokens=${MAX_OUTPUT_TOKENS}`
        : null,
      () => extractCandidateText(parsed.candidates),
    );
    return {
      text,
      cost_usd: cost,
      provider_info: tokenUsageInfo(parsed.modelVersion, opts.model, inTokens, outTokens),
    };
  }

  private async timedFetch(url: string, init: RequestInit): Promise<Response> {
    return timedProviderFetch('Gemini', url, init, {
      timeoutMs: this.timeoutMs,
      fetchImpl: this.fetchImpl,
    });
  }
}

function firstCandidateFinishReason(candidates: unknown): unknown {
  const first = Array.isArray(candidates) ? candidates[0] : undefined;
  return first && typeof first === 'object'
    ? (first as { finishReason?: unknown }).finishReason
    : undefined;
}

function extractCandidateText(candidates: unknown): string {
  if (!Array.isArray(candidates) || candidates.length === 0) return '';
  const first = candidates[0];
  if (
    !first ||
    typeof first !== 'object' ||
    !('content' in first) ||
    typeof (first as { content: unknown }).content !== 'object' ||
    (first as { content: unknown }).content === null
  ) {
    return '';
  }
  const content = (first as { content: { parts?: unknown } }).content;
  if (!Array.isArray(content.parts)) return '';
  const parts: string[] = [];
  for (const part of content.parts) {
    if (
      part &&
      typeof part === 'object' &&
      'text' in part &&
      typeof (part as { text: unknown }).text === 'string'
    ) {
      parts.push((part as { text: string }).text);
    }
  }
  return parts.join('\n').trim();
}

function tokenCount(value: unknown): number {
  return typeof value === 'number' ? value : 0;
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
