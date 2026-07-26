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
  type DescribeOptions,
  type DescribeProvider,
  type DescribeResult,
} from './index.ts';

const ENDPOINT_BASE = 'https://generativelanguage.googleapis.com/v1beta/models';
const MODELS_ENDPOINT = 'https://generativelanguage.googleapis.com/v1beta/models';
const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_TOKENS = 256;

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
  };
}

export class GeminiProvider implements DescribeProvider {
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
      generationConfig: { maxOutputTokens: DEFAULT_MAX_TOKENS },
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

    const text = extractCandidateText(parsed.candidates);
    if (text.length === 0) {
      throw new RemoteError('Gemini returned empty content', false);
    }
    const inTokens =
      typeof parsed.usageMetadata?.promptTokenCount === 'number'
        ? parsed.usageMetadata.promptTokenCount
        : 0;
    const outTokens =
      typeof parsed.usageMetadata?.candidatesTokenCount === 'number'
        ? parsed.usageMetadata.candidatesTokenCount
        : 0;
    const cost = priceForModel(opts.model, inTokens, outTokens);
    return {
      text,
      cost_usd: cost,
      provider_info: {
        model: typeof parsed.modelVersion === 'string' ? parsed.modelVersion : opts.model,
        input_tokens: String(inTokens),
        output_tokens: String(outTokens),
      },
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
          ? `Gemini request timed out after ${this.timeoutMs}ms`
          : `Gemini request failed: ${msg}`,
        true,
      );
    } finally {
      clearTimeout(timer);
    }
  }
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
