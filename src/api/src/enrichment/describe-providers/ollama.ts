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
  done?: unknown;
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

  async describe(jpegBytes: Buffer, opts: DescribeOptions): Promise<DescribeResult> {
    const url = `${this.baseUrl}/api/generate`;
    // Ollama 0.5+ accepts a JSON Schema in `format` and constrains the
    // model's output to it at decode time — eliminates the `bad-enum`,
    // `not-json`, and missing-field failure modes the parser used to
    // dead-letter on. Older Ollama versions ignore the field, so the
    // parser's defensive synonym maps stay relevant for those deploys.
    const requestPayload: Record<string, unknown> = {
      model: opts.model,
      prompt: opts.systemPrompt,
      images: [jpegBytes.toString('base64')],
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

    let parsed: OllamaGenerateResponse;
    try {
      parsed = (await res.json()) as OllamaGenerateResponse;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new RemoteError(`Malformed Ollama JSON: ${msg}`, false);
    }

    const text = typeof parsed.response === 'string' ? parsed.response.trim() : '';
    if (text.length === 0) {
      throw new RemoteError('Ollama returned empty response', false);
    }
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
