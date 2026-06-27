/**
 * HTTP client for a self-hosted Nominatim instance.
 *
 * Maple is a pure consumer — the operator runs Nominatim separately
 * (a Geofabrik extract on a Proxmox VM, in our reference deployment).
 * The client is responsible for:
 *
 *   - Per-call timeout (network + slow cold-cache responses).
 *   - Token-bucket rate limit shared across the whole process.
 *   - Distinguishing 4xx (don't retry — bad input) from 5xx / network
 *     errors (retry).
 *   - A startup `health()` probe that the worker boot path runs before
 *     entering the claim loop.
 *
 * Single-process rate limit is fine for v1. If multiple worker processes
 * ever target the same Nominatim, swap the bucket for a shared
 * Mongo/Redis token store — out of scope here.
 *
 * Spec: `docs/indexer-enrichment.md` §4.1, §4.2.
 */

import type { NominatimReverseResponse } from './place-parser.ts';

/**
 * One candidate from a Nominatim forward geocode `/search` response.
 * Only the fields used by the `GET /api/geocode/search` route are typed;
 * the full Nominatim response carries many more.
 */
export interface NominatimSearchResult {
  /** Nominatim internal place id. */
  place_id: number;
  /** Human-readable full address string. */
  display_name: string;
  /** Latitude as a string (Nominatim JSON quirk). */
  lat: string;
  /** Longitude as a string. */
  lon: string;
  /** Structured address components (same shape as reverse response). */
  address?: Record<string, string>;
}

export interface NominatimClientConfig {
  /** Base URL, e.g. `http://nominatim.lan:8080`. No trailing slash required. */
  baseUrl: string;
  /** Per-call request timeout in milliseconds. Default 5_000. */
  requestTimeoutMs?: number;
  /** Sustained request rate — token bucket refills at this rate per second.
   * Default 10. Burst capacity is `Math.max(1, rateLimitPerSec)`. The
   * runtime value is supplied by `bootstrap.ts` from the resolved
   * `EnrichmentConfig.nominatim_rate_limit_per_sec` (DB → env → default
   * 10), so operators can tune it from `/settings/enrichment` without a
   * redeploy. */
  rateLimitPerSec?: number;
  /** Time source. Override in tests. */
  now?: () => number;
  /** Sleep helper. Override in tests so the rate limiter doesn't actually wait. */
  sleep?: (ms: number) => Promise<void>;
  /** Custom fetch impl. Override in tests with a mock. */
  fetchImpl?: typeof fetch;
}

/**
 * Errors classify as either retryable (network / 5xx / timeout) or terminal
 * (4xx, malformed JSON). The worker uses `retryable` to decide whether to
 * bump `attempts` toward dead-letter or surface the error directly.
 */
export class NominatimError extends Error {
  readonly retryable: boolean;
  readonly status?: number;
  constructor(message: string, retryable: boolean, status?: number) {
    super(message);
    this.name = 'NominatimError';
    this.retryable = retryable;
    this.status = status;
  }
}

const DEFAULT_TIMEOUT_MS = 5_000;
const DEFAULT_RATE_LIMIT = 10;

export class NominatimClient {
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly rateLimitPerSec: number;
  private readonly bucketCapacity: number;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly fetchImpl: typeof fetch;

  // Token bucket state. `tokens` is fractional so a refill rate of 10/s
  // produces one token per 100 ms; when `tokens >= 1` we may proceed.
  private tokens: number;
  private lastRefillAt: number;

  constructor(config: NominatimClientConfig) {
    this.baseUrl = config.baseUrl.replace(/\/+$/, '');
    this.timeoutMs = config.requestTimeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.rateLimitPerSec = config.rateLimitPerSec ?? DEFAULT_RATE_LIMIT;
    this.bucketCapacity = Math.max(1, this.rateLimitPerSec);
    this.now = config.now ?? (() => Date.now());
    this.sleep = config.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.fetchImpl = config.fetchImpl ?? fetch;

    this.tokens = this.bucketCapacity;
    this.lastRefillAt = this.now();
  }

  /**
   * GET `/status`. Throws if the instance is unreachable or returns non-2xx.
   * The worker boot path calls this once and exits the process on failure,
   * so a typo in the URL or an unbooted Proxmox VM fails loud.
   */
  async health(): Promise<void> {
    const url = `${this.baseUrl}/status`;
    const res = await this.timedFetch(url);
    if (!res.ok) {
      throw new NominatimError(`Nominatim /status returned ${res.status}`, false, res.status);
    }
  }

  /** GET `/reverse?lat=...&lon=...`. Returns parsed JSON; throws on failure. */
  async reverse(lat: number, lon: number): Promise<NominatimReverseResponse> {
    await this.acquireToken();
    const params = new URLSearchParams({
      lat: String(lat),
      lon: String(lon),
      format: 'jsonv2',
      addressdetails: '1',
      extratags: '1',
      namedetails: '1',
      zoom: '18',
    });
    const url = `${this.baseUrl}/reverse?${params.toString()}`;
    const res = await this.timedFetch(url);

    if (res.status >= 500) {
      throw new NominatimError(`Nominatim 5xx: ${res.status}`, true, res.status);
    }
    if (res.status >= 400) {
      throw new NominatimError(`Nominatim 4xx: ${res.status}`, false, res.status);
    }

    let body: unknown;
    try {
      body = await res.json();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new NominatimError(`Malformed Nominatim JSON: ${msg}`, false);
    }

    if (typeof body !== 'object' || body === null) {
      throw new NominatimError('Nominatim response was not an object', false);
    }
    return body as NominatimReverseResponse;
  }

  /**
   * GET `/search?q=…`. Forward geocode: returns up to `limit` candidates
   * ordered by Nominatim's relevance score. Rate-limited by the same bucket
   * as `reverse()`. Empty array when no results. Throws `NominatimError`
   * on failure (retryable classification matches `reverse()`).
   */
  async search(q: string, limit = 5): Promise<NominatimSearchResult[]> {
    await this.acquireToken();
    const params = new URLSearchParams({
      q,
      format: 'jsonv2',
      addressdetails: '1',
      limit: String(limit),
    });
    const url = `${this.baseUrl}/search?${params.toString()}`;
    const res = await this.timedFetch(url);

    if (res.status >= 500) {
      throw new NominatimError(`Nominatim 5xx: ${res.status}`, true, res.status);
    }
    if (res.status >= 400) {
      throw new NominatimError(`Nominatim 4xx: ${res.status}`, false, res.status);
    }

    let body: unknown;
    try {
      body = await res.json();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new NominatimError(`Malformed Nominatim JSON: ${msg}`, false);
    }

    if (!Array.isArray(body)) {
      throw new NominatimError('Nominatim /search response was not an array', false);
    }
    return body as NominatimSearchResult[];
  }

  /** Wrap `fetchImpl` with an `AbortController`-based timeout. Network
   * failures (DNS, connection refused) and timeouts both bubble up as
   * retryable `NominatimError`s. */
  private async timedFetch(url: string): Promise<Response> {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.timeoutMs);
    try {
      return await this.fetchImpl(url, { signal: ctrl.signal });
    } catch (err) {
      const aborted = err instanceof Error && (err.name === 'AbortError' || ctrl.signal.aborted);
      const msg = err instanceof Error ? err.message : String(err);
      throw new NominatimError(
        aborted
          ? `Nominatim request timed out after ${this.timeoutMs}ms`
          : `Nominatim request failed: ${msg}`,
        true,
      );
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Block until at least one token is available, then consume it.
   *
   * The bucket refills continuously at `rateLimitPerSec`: when the next call
   * arrives we credit `(now - lastRefillAt) * rate / 1000` tokens (capped
   * at the bucket capacity). If we still have less than one token, sleep
   * just long enough for the next token to mature.
   */
  private async acquireToken(): Promise<void> {
    while (true) {
      const t = this.now();
      const elapsedMs = Math.max(0, t - this.lastRefillAt);
      this.tokens = Math.min(
        this.bucketCapacity,
        this.tokens + (elapsedMs * this.rateLimitPerSec) / 1000,
      );
      this.lastRefillAt = t;
      if (this.tokens >= 1) {
        this.tokens -= 1;
        return;
      }
      const tokensNeeded = 1 - this.tokens;
      const waitMs = Math.max(1, Math.ceil((tokensNeeded / this.rateLimitPerSec) * 1000));
      await this.sleep(waitMs);
    }
  }
}
