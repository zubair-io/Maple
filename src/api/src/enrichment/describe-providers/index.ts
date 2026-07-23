/**
 * Describe-provider abstraction. The slow-tier `describe` worker delegates the
 * actual JPEG-bytes → caption call to one of these providers; everything else
 * (claim/lease, retries, cost cap, Mongo writes) lives in the worker.
 *
 * Each implementation lives in its own file under `describe-providers/` and
 * shares this contract:
 *
 *   - `describe(jpegFrames, opts)` returns the caption text plus a `cost_usd`
 *     estimate and a `provider_info` blob the worker stores on
 *     `asset.description_meta` for triage / cost-tracking.
 *   - `health()` is the boot probe, mirroring `NominatimClient.health()`.
 *     Throws on misconfiguration (missing API key, bad URL) or unreachable
 *     endpoint.
 *   - Errors are surfaced as `RemoteError`s so the worker can classify
 *     4xx-vs-5xx the same way the geocode worker does with `NominatimError`.
 *
 * Default provider is Ollama (local, free); paid providers (Anthropic, OpenAI,
 * Gemini) read their API key from `MAPLE_${PROVIDER}_API_KEY`. A paid provider
 * with no key set is a fail-fast at boot — never silently downgrades.
 *
 * Spec: `docs/indexer-enrichment.md` §6 + §8.
 */

import { OllamaProvider } from './ollama.ts';
import { AnthropicProvider } from './anthropic.ts';
import { OpenAIProvider } from './openai.ts';
import { GeminiProvider } from './gemini.ts';

export type DescribeProviderName = 'ollama' | 'anthropic' | 'openai' | 'gemini';

export interface DescribeOptions {
  /** Caption-generation prompt. Sent verbatim — worker resolves the
   * configured prompt from the DB / default before calling. */
  systemPrompt: string;
  /** Model id, e.g. `"llava:latest"` or `"claude-haiku-4-5"`. */
  model: string;
  /** Optional JSON Schema for structured-output constraint. Currently only
   * the Ollama provider reads this (forwarded to `/api/generate`'s `format`
   * parameter, which Ollama 0.5+ uses to constrain decoding). Anthropic,
   * OpenAI, and Gemini ignore the field today — each platform's structured-
   * output primitive (`response_format: json_schema`, `response_schema`,
   * tool-call schema) would need a separate wiring pass. The parser's
   * defensive coercions remain the only guard for those providers. */
  format?: unknown;
}

export interface DescribeResult {
  /** Caption text, trimmed. Empty string is allowed (the worker writes it
   * verbatim) but providers are encouraged to throw rather than return
   * empty. */
  text: string;
  /** Best-effort USD cost estimate. Ollama is `0`; paid providers use the
   * provider's published per-token / per-char rates. */
  cost_usd: number;
  /** Per-provider diagnostic blob. Stored on `asset.description_meta` for
   * triage. Always strings so Mongo doesn't infer mixed types per field. */
  provider_info: Record<string, string>;
}

export interface DescribeProvider {
  /** Stable name. Echoed back to the operator on save and stamped on
   * `asset.description_meta.provider`. */
  readonly name: DescribeProviderName;
  /**
   * Generate one coherent caption for one or more ordered JPEG frames.
   *
   * Throws `RemoteError` on failure. The worker uses `retryable` to decide
   * whether to bump `attempts` toward dead-letter or surface the error
   * directly (same shape as `NominatimError`).
   */
  describe(jpegFrames: readonly Buffer[], opts: DescribeOptions): Promise<DescribeResult>;
  /** Boot probe. Throws on misconfiguration or unreachable endpoint. The
   * worker bootstrap calls this once before entering the claim loop, so a
   * typo in the URL or a missing API key fails loud rather than dead-
   * lettering every claim. */
  health(): Promise<void>;
}

/**
 * Errors classify as either retryable (network / 5xx / timeout) or terminal
 * (4xx, malformed response). Mirrors `NominatimError` so the worker can
 * use a single classification path.
 */
export class RemoteError extends Error {
  readonly retryable: boolean;
  readonly status?: number;
  constructor(message: string, retryable: boolean, status?: number) {
    super(message);
    this.name = 'RemoteError';
    this.retryable = retryable;
    this.status = status;
  }
}

export interface ProviderFactoryOptions {
  /** Override the provider URL (only meaningful for Ollama; the paid
   * providers hard-code their endpoint). */
  url?: string | null;
  /** Override the API key. When omitted, the provider reads
   * `MAPLE_${PROVIDER}_API_KEY` from env. Tests pass keys explicitly. */
  apiKey?: string | null;
  /** Test override: skip the env-var lookup and use this fetch instead. */
  fetchImpl?: typeof fetch;
  /** Per-call request timeout in milliseconds. Default 5_000. */
  requestTimeoutMs?: number;
}

/**
 * Build the provider for the given name. Throws synchronously when the paid
 * provider is selected but no API key is available — caught by the worker
 * bootstrap and reported via the operator-visible error log so a typo in the
 * settings doesn't silently dead-letter every claim.
 */
export function getDescribeProvider(
  name: DescribeProviderName,
  opts: ProviderFactoryOptions = {},
): DescribeProvider {
  switch (name) {
    case 'ollama':
      return new OllamaProvider({
        baseUrl: opts.url ?? null,
        fetchImpl: opts.fetchImpl,
        requestTimeoutMs: opts.requestTimeoutMs,
      });
    case 'anthropic':
      return new AnthropicProvider({
        apiKey: resolveKey('anthropic', opts.apiKey),
        fetchImpl: opts.fetchImpl,
        requestTimeoutMs: opts.requestTimeoutMs,
      });
    case 'openai':
      return new OpenAIProvider({
        apiKey: resolveKey('openai', opts.apiKey),
        fetchImpl: opts.fetchImpl,
        requestTimeoutMs: opts.requestTimeoutMs,
      });
    case 'gemini':
      return new GeminiProvider({
        apiKey: resolveKey('gemini', opts.apiKey),
        fetchImpl: opts.fetchImpl,
        requestTimeoutMs: opts.requestTimeoutMs,
      });
    default:
      // Exhaustive check — a new provider added to the union without a
      // factory branch fails the type check at compile time.
      throw new Error(`Unknown describe provider: ${String(name as string)}`);
  }
}

/** Look up `MAPLE_${PROVIDER}_API_KEY` when no explicit key is supplied.
 * Throws synchronously if neither source has a value — this is the
 * fail-fast for paid-provider misconfiguration. */
function resolveKey(
  name: Exclude<DescribeProviderName, 'ollama'>,
  explicit: string | null | undefined,
): string {
  if (explicit && explicit.length > 0) return explicit;
  const envName = `MAPLE_${name.toUpperCase()}_API_KEY`;
  const fromEnv = process.env[envName];
  if (fromEnv && fromEnv.length > 0) return fromEnv;
  throw new RemoteError(`${name} provider selected but ${envName} is unset`, false);
}
