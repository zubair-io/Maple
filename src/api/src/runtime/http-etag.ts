/**
 * Tiny utilities for adding RFC-7232 conditional-request handling
 * (ETag + If-None-Match) to JSON / bytes endpoints.
 *
 * Strategy: body-hash ETags. Compute SHA-1 of the response body, quote
 * it. Any byte-level change in the body produces a new ETag, so cache
 * invalidation is automatic and we never have to reason about partial
 * staleness.
 *
 * Used by the File Provider extension to short-circuit enumeration
 * responses when its cached payload is still fresh.
 */

import { createHash } from "node:crypto";

export function computeBodyETag(body: string | Buffer | Uint8Array): string {
  const h = createHash("sha1");
  if (typeof body === "string") h.update(body);
  else h.update(body);
  return `"${h.digest("hex")}"`;
}

/**
 * Compare a client `If-None-Match` header against a server ETag.
 * Tolerates the optional `W/` weak-validator prefix on either side and
 * supports the `*` wildcard (matches any current representation).
 *
 * RFC 9110 §13.1.2 — If-None-Match may carry a comma-separated list of
 * validators. Split, strip the optional W/ weak prefix on each side,
 * and return true if any tag matches.
 */
export function ifNoneMatchEqual(
  clientHeader: string | undefined,
  serverEtag: string,
): boolean {
  if (!clientHeader) return false;
  const trimmed = clientHeader.trim();
  if (trimmed === "*") return true;
  const norm = (s: string): string => {
    const t = s.trim();
    return t.startsWith("W/") ? t.slice(2) : t;
  };
  const serverNorm = norm(serverEtag);
  return trimmed.split(",").some((tag) => norm(tag) === serverNorm);
}
