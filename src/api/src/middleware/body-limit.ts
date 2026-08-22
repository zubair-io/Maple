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
 * Why only ONE route is allowlisted: Elysia's lifecycle parses the body
 * BEFORE `beforeHandle` auth runs, so any route with a `body:` schema
 * buffers unauthenticated bytes into memory. The backup chunk endpoints
 * declare `body: t.Any()` but their client (`UploadClient`) sends fixed
 * 4MB chunks, so the 128MB default bounds them with huge margin. The
 * folders upload route declares NO body schema — its handler reads the
 * raw stream to disk, and only after auth has passed — so it is the one
 * route where a multi-GB declared length is safe to admit. Big bodies
 * with no Authorization header at all fail fast with 401 here in
 * `onRequest`, before anything reads the stream.
 *
 * A client that lies with a chunked body and no `Content-Length` is still
 * bounded by the server-wide cap. Every Maple client sends `Content-Length`
 * on its uploads, so the residual gap is a deliberately-malformed request on
 * a LAN-scoped, auth-gated, single-user server — accepted.
 */
import { Elysia } from 'elysia';
import { MAX_REQUEST_BODY_BYTES } from '../runtime/tls-config.ts';

/** Bun's pre-#2994 default — every non-streaming route keeps exactly this bound. */
export const DEFAULT_BODY_LIMIT_BYTES = 128 * 1024 * 1024;

/** The routes that stream arbitrarily large bodies to disk WITHOUT an
 * Elysia body schema (nothing buffers before auth). Keep schema-parsed
 * routes (e.g. the 4MB-chunked backup endpoints) OFF this list. */
const STREAMING_PATHS: RegExp[] = [/^\/api\/folders\/[^/]+\/upload$/];

export function bodyLimitForPath(pathname: string): number {
  return STREAMING_PATHS.some((re) => re.test(pathname))
    ? MAX_REQUEST_BODY_BYTES
    : DEFAULT_BODY_LIMIT_BYTES;
}

type Rejection = { status: 401 | 413; body: { error: string } };

/**
 * Decides whether to fail a request fast, before its body is ever read:
 * 413 when the declared Content-Length exceeds the route's limit, 401 when
 * a larger-than-default body arrives without any Authorization header (an
 * unauthenticated caller has no business shipping gigabytes — real auth
 * still happens in `requireAuth`; this is a DoS gate, not authentication).
 * Pure — unit-tested directly. Returns null to let the request through.
 */
export function bodyRejection(
  method: string,
  pathname: string,
  contentLength: string | null,
  authorization: string | null,
): Rejection | null {
  if (method !== 'POST' && method !== 'PUT' && method !== 'PATCH') return null;
  const declared = contentLength === null ? NaN : Number(contentLength);
  if (!Number.isFinite(declared)) return null;
  const limit = bodyLimitForPath(pathname);
  if (declared > limit) {
    return {
      status: 413,
      body: {
        error: `Request body of ${declared} bytes exceeds the ${limit}-byte limit for this endpoint`,
      },
    };
  }
  if (declared > DEFAULT_BODY_LIMIT_BYTES && authorization === null) {
    return {
      status: 401,
      body: { error: 'Authorization required before uploading a large body' },
    };
  }
  return null;
}

export const bodyLimit = new Elysia({ name: 'bodyLimit' }).onRequest(({ request, set }) => {
  const rejection = bodyRejection(
    request.method,
    new URL(request.url).pathname,
    request.headers.get('content-length'),
    request.headers.get('authorization'),
  );
  if (rejection === null) return;
  set.status = rejection.status;
  return rejection.body;
});
