/**
 * Per-route request-body ceilings (#2993, Jules review on PR #2994).
 *
 * Bun's `maxRequestBodySize` is a single server-wide number. The streaming
 * upload endpoints need it huge (a real video can be tens of GB, and those
 * routes pipe the body straight to disk), but leaving a huge cap on EVERY
 * route would let one oversized JSON POST get buffered into memory by the
 * body parser and OOM the single-process API. So the server-wide Bun cap is
 * `MAX_REQUEST_BODY_BYTES`, and this guard rejects any request whose
 * declared `Content-Length` exceeds its route's limit BEFORE the body is
 * read: the streaming allowlist below keeps the full ceiling, everything
 * else gets `DEFAULT_BODY_LIMIT_BYTES` (Bun's own former default, so
 * non-upload routes behave exactly as before #2994).
 *
 * A client that lies with a chunked body and no `Content-Length` is still
 * bounded by the server-wide cap. Every Maple client sends `Content-Length`
 * on its uploads, so the residual gap is a deliberately-malformed request on
 * a LAN-scoped, auth-gated, single-user server — accepted.
 */
import { Elysia } from 'elysia';
import { MAX_REQUEST_BODY_BYTES } from '../runtime/tls-config.ts';

/** Bun's pre-#2994 default — non-streaming routes keep exactly this bound. */
export const DEFAULT_BODY_LIMIT_BYTES = 128 * 1024 * 1024;

/** Routes that stream arbitrarily large bodies to disk. */
const STREAMING_PATHS: RegExp[] = [
  /^\/api\/folders\/[^/]+\/upload$/,
  /^\/api\/libraries\/[^/]+\/backup\/(ingest|rendered)$/,
];

export function bodyLimitForPath(pathname: string): number {
  return STREAMING_PATHS.some((re) => re.test(pathname))
    ? MAX_REQUEST_BODY_BYTES
    : DEFAULT_BODY_LIMIT_BYTES;
}

/**
 * Returns the 413 body when the request declares a body larger than its
 * route allows, or null to let it through. Pure — unit-tested directly.
 */
export function oversizedBodyRejection(
  method: string,
  pathname: string,
  contentLength: string | null,
): { error: string } | null {
  if (method !== 'POST' && method !== 'PUT' && method !== 'PATCH') return null;
  const declared = contentLength === null ? NaN : Number(contentLength);
  if (!Number.isFinite(declared)) return null;
  const limit = bodyLimitForPath(pathname);
  if (declared <= limit) return null;
  return {
    error: `Request body of ${declared} bytes exceeds the ${limit}-byte limit for this endpoint`,
  };
}

export const bodyLimit = new Elysia({ name: 'bodyLimit' }).onRequest(({ request, set }) => {
  const rejection = oversizedBodyRejection(
    request.method,
    new URL(request.url).pathname,
    request.headers.get('content-length'),
  );
  if (rejection === null) return;
  set.status = 413;
  return rejection;
});
