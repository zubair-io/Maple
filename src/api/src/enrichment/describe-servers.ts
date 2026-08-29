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
const MIN_CONCURRENCY = 1;
/** A single Ollama host serving a 12B vision model saturates long before
 * this; the ceiling only exists to catch a mistyped three-digit value. */
const MAX_CONCURRENCY = 32;
/** Bounded so a runaway client can't write an unbounded array into the
 * settings doc. Eight distinct GPU boxes is already an unusual deploy. */
export const MAX_DESCRIBE_SERVERS = 8;
/** The describe stage's dispatch fan-out is the sum of these numbers, and
 * that fan-out is a stage concurrency — which `PATCH /api/workers/:name/config`
 * caps at 100. Enforcing the same ceiling here keeps the two surfaces from
 * disagreeing: without it, 8 servers × 32 could persist a stage concurrency
 * no operator could have set through the workers route. */
export const MAX_TOTAL_DESCRIBE_CAPACITY = 100;

/** Normalise one entry's URL. Returns the cleaned URL or the reason it
 * cannot be used. */
function parseUrl(raw: unknown): string | { error: string } {
  if (typeof raw !== 'string') return { error: 'url is required' };
  const url = validateHttpUrl(raw);
  if (url === null) return { error: 'url is required' };
  return typeof url === 'object' ? { error: url.error } : url;
}

/** Absent/null takes the default; anything else must be an integer in
 * range. */
function parseConcurrency(raw: unknown): number | { error: string } {
  if (raw === undefined || raw === null) return DEFAULT_DESCRIBE_SERVER_CONCURRENCY;
  const valid =
    typeof raw === 'number' &&
    Number.isInteger(raw) &&
    raw >= MIN_CONCURRENCY &&
    raw <= MAX_CONCURRENCY;
  return valid
    ? raw
    : { error: `concurrency must be an integer between ${MIN_CONCURRENCY} and ${MAX_CONCURRENCY}` };
}

/** Validate one list entry. Both entry points share this so the write path
 * (400) and the read path (drop) can never disagree on what "valid" means. */
function parseEntry(entry: unknown): DescribeServerConfig | { error: string } {
  if (typeof entry !== 'object' || entry === null) {
    return { error: 'must be an object with a url' };
  }
  const fields = entry as Record<string, unknown>;
  const url = parseUrl(fields.url);
  if (typeof url === 'object') return url;
  const concurrency = parseConcurrency(fields.concurrency);
  if (typeof concurrency === 'object') return concurrency;
  return { url, concurrency };
}

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
    const parsed = parseEntry(entry);
    if ('error' in parsed) return { error: `server ${index + 1}: ${parsed.error}` };
    if (seen.has(parsed.url)) {
      return { error: `server ${index + 1}: duplicate url ${parsed.url}` };
    }
    seen.add(parsed.url);
    out.push(parsed);
  }

  const total = totalDescribeCapacity(out);
  if (total > MAX_TOTAL_DESCRIBE_CAPACITY) {
    return {
      error: `total concurrency across servers must be at most ${MAX_TOTAL_DESCRIBE_CAPACITY} (got ${total})`,
    };
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
    const parsed = parseEntry(entry);
    // A bad concurrency alone is not worth dropping a server the operator
    // clearly meant to configure — fall back to the default for it.
    const usable = 'error' in parsed ? retryWithDefaultConcurrency(entry) : parsed;
    if (!usable || seen.has(usable.url)) continue;
    seen.add(usable.url);
    out.push(usable);
  }
  return out.length > 0 ? out : null;
}

/** Second chance for an entry whose only problem was the number. */
function retryWithDefaultConcurrency(entry: unknown): DescribeServerConfig | null {
  if (typeof entry !== 'object' || entry === null) return null;
  const retry = parseEntry({ ...(entry as Record<string, unknown>), concurrency: undefined });
  return 'error' in retry ? null : retry;
}

/** Total in-flight describe requests allowed across every configured
 * server. The describe stage's dispatch fan-out is clamped to this. */
export function totalDescribeCapacity(servers: readonly DescribeServerConfig[]): number {
  return servers.reduce((sum, server) => sum + server.concurrency, 0);
}
