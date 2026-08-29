/**
 * Multi-server describe configuration: the operator-editable list of Ollama
 * endpoints the describe stage may call, each with its own concurrency.
 *
 * Shape rules (enforced here, once, so the route, the repo, the resolver and
 * the pool can't disagree):
 *
 *   - The list is ordered. Entry 0 is the DEFAULT server: every other
 *     consumer of a shared Ollama endpoint (semantic-search embedder,
 *     generated-search) reads `describe_provider_url`, which the resolver
 *     mirrors from entry 0. Reordering in the UI is what "make this the
 *     default" means.
 *   - `concurrency` is per server — the describe stage never has more than
 *     that many requests in flight against one endpoint. The stage's total
 *     capacity is the sum across servers.
 *   - URLs are normalised (origin + path, no query/hash, no trailing slash)
 *     and de-duplicated; two entries for the same endpoint would silently
 *     double that endpoint's real concurrency.
 *
 * Types live here rather than in `enrichment-config.repo.ts` so both the
 * repo and the resolver can import them without a cycle, and so the file
 * budget stays comfortable on both.
 */

import { validateHttpUrl } from '../observability/observability-config.repo.ts';

export interface DescribeServerConfig {
  /** Normalised base URL, e.g. `http://gpu-box:11434`. */
  url: string;
  /** Maximum in-flight describe requests against this server. */
  concurrency: number;
}

/** Per-server default when the operator adds a row without touching the
 * number — matches the describe stage's historical single-server
 * `defaults.concurrency`. */
export const DEFAULT_DESCRIBE_SERVER_CONCURRENCY = 2;
export const MIN_DESCRIBE_SERVER_CONCURRENCY = 1;
/** A single Ollama host serving a 12B vision model saturates long before
 * this; the ceiling only exists to catch a mistyped three-digit value. */
export const MAX_DESCRIBE_SERVER_CONCURRENCY = 32;
/** Bounded so a runaway client can't write an unbounded array into the
 * settings doc. Eight distinct GPU boxes is already an unusual deploy. */
export const MAX_DESCRIBE_SERVERS = 8;

/**
 * Validate + normalise a client-supplied `describe_servers` value.
 *
 * Returns the cleaned list, or `{ error }` describing the first problem —
 * the PUT route turns that into a 400 rather than persisting a list the
 * pool would then have to defend against. `null` (or an empty array) means
 * "no explicit list": the resolver falls back to the single
 * `describe_provider_url` server.
 */
export function validateDescribeServers(
  raw: unknown,
): DescribeServerConfig[] | null | { error: string } {
  if (raw === null || raw === undefined) return null;
  if (!Array.isArray(raw)) return { error: 'must be an array of { url, concurrency }' };
  if (raw.length === 0) return null;
  if (raw.length > MAX_DESCRIBE_SERVERS) {
    return { error: `at most ${MAX_DESCRIBE_SERVERS} servers (got ${raw.length})` };
  }

  const seen = new Set<string>();
  const out: DescribeServerConfig[] = [];
  for (const [index, entry] of raw.entries()) {
    if (typeof entry !== 'object' || entry === null) {
      return { error: `server ${index + 1}: must be an object with a url` };
    }
    const { url: rawUrl, concurrency: rawConcurrency } = entry as Record<string, unknown>;
    if (typeof rawUrl !== 'string' || rawUrl.trim().length === 0) {
      return { error: `server ${index + 1}: url is required` };
    }
    const url = validateHttpUrl(rawUrl);
    if (url === null) return { error: `server ${index + 1}: url is required` };
    if (typeof url === 'object') return { error: `server ${index + 1}: ${url.error}` };
    if (seen.has(url)) return { error: `server ${index + 1}: duplicate url ${url}` };
    seen.add(url);

    const concurrency =
      rawConcurrency === undefined || rawConcurrency === null
        ? DEFAULT_DESCRIBE_SERVER_CONCURRENCY
        : rawConcurrency;
    if (
      typeof concurrency !== 'number' ||
      !Number.isInteger(concurrency) ||
      concurrency < MIN_DESCRIBE_SERVER_CONCURRENCY ||
      concurrency > MAX_DESCRIBE_SERVER_CONCURRENCY
    ) {
      return {
        error: `server ${index + 1}: concurrency must be an integer between ${MIN_DESCRIBE_SERVER_CONCURRENCY} and ${MAX_DESCRIBE_SERVER_CONCURRENCY}`,
      };
    }
    out.push({ url, concurrency });
  }
  return out;
}

/**
 * Read-side normalisation for a persisted list. Same rules as
 * `validateDescribeServers`, but a bad entry is dropped rather than
 * rejected: a config doc written by an older/broken client must never stop
 * the worker booting. Returns `null` when nothing usable survives.
 */
export function normalizeDescribeServers(raw: unknown): DescribeServerConfig[] | null {
  if (!Array.isArray(raw)) return null;
  const seen = new Set<string>();
  const out: DescribeServerConfig[] = [];
  for (const entry of raw.slice(0, MAX_DESCRIBE_SERVERS)) {
    if (typeof entry !== 'object' || entry === null) continue;
    const { url: rawUrl, concurrency: rawConcurrency } = entry as Record<string, unknown>;
    if (typeof rawUrl !== 'string') continue;
    const url = validateHttpUrl(rawUrl);
    if (url === null || typeof url === 'object') continue;
    if (seen.has(url)) continue;
    seen.add(url);
    const concurrency =
      typeof rawConcurrency === 'number' &&
      Number.isInteger(rawConcurrency) &&
      rawConcurrency >= MIN_DESCRIBE_SERVER_CONCURRENCY &&
      rawConcurrency <= MAX_DESCRIBE_SERVER_CONCURRENCY
        ? rawConcurrency
        : DEFAULT_DESCRIBE_SERVER_CONCURRENCY;
    out.push({ url, concurrency });
  }
  return out.length > 0 ? out : null;
}

/** Total in-flight describe requests allowed across every configured
 * server. The describe stage's dispatch fan-out is clamped to this. */
export function totalDescribeCapacity(servers: readonly DescribeServerConfig[]): number {
  return servers.reduce((sum, server) => sum + server.concurrency, 0);
}
