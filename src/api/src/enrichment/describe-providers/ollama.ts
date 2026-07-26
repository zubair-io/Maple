/**
 * Ollama vision-LLM provider — local, free, default.
 *
 * Posts to `${baseUrl}/api/generate` with the image as a base64 string in
 * the request body, per the Ollama HTTP API. Default model `llava:latest`.
 *
 * Cost is always 0 — local CPU/GPU. We still populate `provider_info` with
 * the model id and basic timing so the UI can show what generated each
 * caption.
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

const DEFAULT_BASE_URL = 'http://localhost:11434';
// qwen3-vl:8b on a 24 GB GPU is 8–12s typical per image (15-60% faster
// than the prior qwen2.5vl:7b generation per-token, similar VRAM), but can
// spike to 30–60s under cold-load or when the model is paged in. 120s
// leaves headroom without masking a genuinely hung backend.
const DEFAULT_TIMEOUT_MS = 120_000;

export interface OllamaProviderConfig {
  /** Base URL, e.g. `http://localhost:11434`. Defaults to localhost when
   * the operator hasn't set anything. Trailing slashes are stripped. */
  baseUrl?: string | null;
  /** Per-call request timeout in milliseconds. Default 60_000. Local
   * inference can take tens of seconds on CPU. */
  requestTimeoutMs?: number;
  /** Test override. */
  fetchImpl?: typeof fetch;
}

interface OllamaGenerateResponse {
  model?: unknown;
  response?: unknown;
  thinking?: unknown;
  done?: unknown;
  done_reason?: unknown;
  total_duration?: unknown;
  eval_count?: unknown;
}

export class OllamaProvider implements DescribeProvider {
  readonly name = 'ollama' as const;

  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(config: OllamaProviderConfig = {}) {
    const raw = config.baseUrl ?? DEFAULT_BASE_URL;
    this.baseUrl = raw.replace(/\/+$/, '');
    this.timeoutMs = config.requestTimeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.fetchImpl = config.fetchImpl ?? fetch;
  }

  /** GET `/api/tags`. Throws on non-2xx. Used at boot to verify the
   * Ollama server is reachable. */
  async health(): Promise<void> {
    const url = `${this.baseUrl}/api/tags`;
    const res = await this.timedFetch(url, { method: 'GET' });
    if (!res.ok) {
      throw new RemoteError(`Ollama /api/tags returned ${res.status}`, false, res.status);
    }
  }

  async describe(jpegFrames: readonly Buffer[], opts: DescribeOptions): Promise<DescribeResult> {
    requireFrames(jpegFrames);
    const url = `${this.baseUrl}/api/generate`;
    // Ollama 0.5+ accepts a JSON Schema in `format` and constrains the
    // model's output to it at decode time — eliminates the `bad-enum`,
    // `not-json`, and missing-field failure modes the parser used to
    // dead-letter on. Older Ollama versions ignore the field, so the
    // parser's defensive synonym maps stay relevant for those deploys.
    const requestPayload: Record<string, unknown> = {
      model: opts.model,
      prompt: opts.systemPrompt,
      images: jpegFrames.map((frame) => frame.toString('base64')),
      stream: false,
    };
    if (opts.format !== undefined) {
      requestPayload.format = opts.format;
    }
    const body = JSON.stringify(requestPayload);
    const res = await this.timedFetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body,
    });
    classifyHttp(res, 'Ollama');
    const parsed = await parseGenerateBody(res);
    const text = extractGeneratedText(parsed, res.status, opts.model);
    return {
      text,
      cost_usd: 0,
      provider_info: {
        model: typeof parsed.model === 'string' ? parsed.model : opts.model,
        eval_count: typeof parsed.eval_count === 'number' ? String(parsed.eval_count) : '0',
        total_duration_ms:
          typeof parsed.total_duration === 'number'
            ? String(Math.round(parsed.total_duration / 1_000_000))
            : '0',
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
          ? `Ollama request timed out after ${this.timeoutMs}ms`
          : `Ollama request failed: ${msg}`,
        true,
      );
    } finally {
      clearTimeout(timer);
    }
  }
}

/** Decode the `/api/generate` JSON body; a body that isn't JSON is a
 * terminal failure (the server answered, its answer is garbage). */
async function parseGenerateBody(res: Response): Promise<OllamaGenerateResponse> {
  try {
    return (await res.json()) as OllamaGenerateResponse;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new RemoteError(`Malformed Ollama JSON: ${msg}`, false);
  }
}

/**
 * Resolve the model's generated text out of a decoded `/api/generate` body.
 *
 * qwen3-vl is a thinking model. Under a `format` JSON-schema constraint the
 * grammar prevents it from emitting its `</think>` terminator, so Ollama's
 * template parser (observed on 0.30.11; `think: false` does not help)
 * classifies the ENTIRE constrained output as `thinking` and hands back
 * `response: ""` — with `done_reason: "stop"` and a healthy eval_count,
 * because generation itself succeeded. When that happens the thinking text
 * IS the schema-constrained JSON, so recover it; the strict VisionDoc parse
 * downstream rejects genuine reasoning prose. This was the actual producer
 * of the #2172 dead-letters. `response` wins whenever it is non-empty.
 *
 * A genuinely empty result (no response AND no thinking) is transient in
 * practice — a generate hit racing a model load/eviction (`done_reason:
 * "load"`), or a backend under memory pressure. Classify retryable so the
 * stage's attempt budget (and an operator retry-dead after the provider
 * heals) can recover the asset.
 */
function extractGeneratedText(
  parsed: OllamaGenerateResponse,
  httpStatus: number,
  requestedModel: string,
): string {
  const responseText = typeof parsed.response === 'string' ? parsed.response.trim() : '';
  const thinkingText = typeof parsed.thinking === 'string' ? parsed.thinking.trim() : '';
  const text = responseText.length > 0 ? responseText : thinkingText;
  if (text.length === 0) {
    const detail = emptyResponseDetail(parsed, httpStatus, requestedModel, thinkingText.length);
    throw new RemoteError(`Ollama returned empty response (${detail})`, true, httpStatus);
  }
  return text;
}

/**
 * Operator-facing diagnostic detail for an empty-response failure. The
 * returned string lands verbatim in `stages.describe.last_error` — all the
 * operator sees in the Workers dead list — so it must identify the provider
 * state (which model, did generation finish, why, how many tokens went
 * where) without including prompt or image content. `thinking_chars`
 * distinguishes a thinking-misroute (large) from a genuinely empty
 * generation (0).
 */
function emptyResponseDetail(
  parsed: OllamaGenerateResponse,
  httpStatus: number,
  requestedModel: string,
  thinkingChars: number,
): string {
  return [
    `model=${typeof parsed.model === 'string' ? parsed.model : requestedModel}`,
    `http=${httpStatus}`,
    `done=${typeof parsed.done === 'boolean' ? parsed.done : 'unknown'}`,
    `done_reason=${typeof parsed.done_reason === 'string' ? parsed.done_reason : 'unknown'}`,
    `eval_count=${typeof parsed.eval_count === 'number' ? parsed.eval_count : 'unknown'}`,
    `thinking_chars=${thinkingChars}`,
    `total_duration_ms=${
      typeof parsed.total_duration === 'number'
        ? Math.round(parsed.total_duration / 1_000_000)
        : 'unknown'
    }`,
  ].join(', ');
}

/** Shared 4xx/5xx classifier. Same shape across providers — keep them in
 * sync so the worker's retry logic doesn't need per-provider branches. */
function classifyHttp(res: Response, providerLabel: string): void {
  if (res.status >= 500) {
    throw new RemoteError(`${providerLabel} 5xx: ${res.status}`, true, res.status);
  }
  if (res.status >= 400) {
    throw new RemoteError(`${providerLabel} 4xx: ${res.status}`, false, res.status);
  }
}
