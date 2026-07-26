// Per-process auth rate limiter (#862).
//
// Why not the `elysia-rate-limit` plugin: that library is a per-INSTANCE plugin
// (it limits every route mounted on the instance via a generator). Our limiter
// is called IMPERATIVELY inside a handful of specific handlers with one shared
// key (`auth:<ip>`), which the plugin model can't express without also gating
// unrelated auth routes (/bootstrap, /me, …). So we keep the imperative API and
// harden it to the same properties the issue asks for:
//   - bounded store (LRU cap, was an unbounded Map — a slow memory-leak / DoS),
//   - client key derived from a TRUSTED proxy hop, never the spoofable leftmost
//     X-Forwarded-For entry.
// Per-process by design; a shared store would only matter behind multi-replica.

/** Max distinct keys retained. Beyond this, the least-recently-used key is
 * evicted — bounds memory regardless of how many distinct IPs are seen. */
const MAX_KEYS = 5000;

const buckets = new Map<string, number[]>();

export function rateLimit(key: string, max: number, windowMs: number): boolean {
  const now = Date.now();
  const arr = (buckets.get(key) ?? []).filter((t) => now - t < windowMs);
  // Re-insert to move this key to the end (most-recently-used) on every touch.
  buckets.delete(key);
  if (arr.length >= max) {
    buckets.set(key, arr);
    return false;
  }
  arr.push(now);
  buckets.set(key, arr);
  // Evict the least-recently-used key(s) if over the cap. Map iteration is
  // insertion order, so the first key is the LRU.
  while (buckets.size > MAX_KEYS) {
    const oldest = buckets.keys().next().value;
    if (oldest === undefined) break;
    buckets.delete(oldest);
  }
  return true;
}

/** Number of trusted reverse-proxy hops in front of the API (deploy topology).
 * Default 1 (the common self-hosted single-reverse-proxy setup). Set to 0 when
 * the API is directly internet-facing so X-Forwarded-For is never trusted. */
export function trustedProxyCount(): number {
  const n = Number(process.env.MAPLE_TRUSTED_PROXIES);
  return Number.isInteger(n) && n >= 0 ? n : 1;
}

/**
 * Derive the client IP for rate-limiting from a TRUSTED proxy hop — not the
 * leftmost X-Forwarded-For entry, which a client can spoof to dodge the limit.
 *
 * With `MAPLE_TRUSTED_PROXIES = N` hops, the real client is the entry the
 * outermost trusted proxy appended (counting N from the right); client-supplied
 * entries to the left are ignored. With N = 0, X-Forwarded-For is not trusted at
 * all and we fall back to `X-Real-IP` / `anon`.
 */
export function clientIp(request: Request): string {
  const trust = trustedProxyCount();
  if (trust > 0) {
    const xff = request.headers.get('x-forwarded-for');
    if (xff) {
      const parts = xff
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
      if (parts.length > 0) {
        const i = Math.max(0, parts.length - trust);
        return parts[i];
      }
    }
  }
  return request.headers.get('x-real-ip')?.trim() || 'anon';
}

/** Test-only: reset the limiter state between tests. */
export function __resetRateLimitForTests(): void {
  buckets.clear();
}
