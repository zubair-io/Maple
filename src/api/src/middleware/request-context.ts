/**
 * Request-context middleware: assigns a stable `requestId` to every inbound
 * request, exposes it on `set.headers["X-Request-Id"]`, plumbs it into a
 * pino child logger, and normalises every non-2xx response into the project
 * error envelope.
 *
 * Envelope (matches issue #133 / Exposure spec 03):
 *
 *     { error: string, code: string, requestId: string, details?: object }
 *
 * The `error` field stays a plain string so existing clients that read
 * `body.error` keep working — this is purely additive (`code`, `requestId`,
 * `details`). No route handlers need to change.
 *
 * Wiring (in `src/api/src/index.ts`):
 *
 *     new Elysia()
 *       .use(requestContext)
 *       // ... CORS, routes, etc.
 *
 * `requestContext` registers itself with `as: "global"` on `onRequest`,
 * `derive`, `onError`, and `mapResponse` so it covers every route mounted
 * downstream, including sub-apps (e.g. the authed-API sub-tree) and the
 * static-UI plugin.
 *
 * Why both `onError` AND `mapResponse`?
 *   - `onError` catches thrown errors (e.g. `requireAuth` throws 401, an
 *     uncaught exception 500s) and writes a fresh envelope.
 *   - `mapResponse` catches routes that set `set.status = 4xx/5xx` and
 *     `return { error: "..." }` without throwing — those bypass `onError`
 *     entirely. mapResponse rewraps the body in the envelope so the schema
 *     is uniform.
 */

import { Elysia } from "elysia";
import { randomUUID } from "node:crypto";
import type { Logger } from "pino";
import { child as childLogger } from "../log.ts";

/** Canonical, stable error codes returned in the envelope. */
export type ErrorCode =
  | "bad_request"
  | "unauthorized"
  | "forbidden"
  | "not_found"
  | "conflict"
  | "unsupported_media_type"
  | "validation"
  | "service_unavailable"
  | "internal";

export interface ErrorEnvelope {
  error: string;
  code: ErrorCode;
  requestId: string;
  details?: Record<string, unknown>;
}

const STATUS_TO_CODE: Record<number, ErrorCode> = {
  400: "bad_request",
  401: "unauthorized",
  403: "forbidden",
  404: "not_found",
  409: "conflict",
  415: "unsupported_media_type",
  422: "validation",
  503: "service_unavailable",
};

function codeForStatus(status: number): ErrorCode {
  if (STATUS_TO_CODE[status]) return STATUS_TO_CODE[status];
  if (status >= 400 && status < 500) return "bad_request";
  return "internal";
}

/** True if `v` is a non-null object (i.e. could already be an envelope). */
function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

/** Extract a numeric status from Elysia's `set.status` (number or status name). */
function statusAsNumber(s: unknown): number {
  if (typeof s === "number") return s;
  // Elysia accepts named statuses ("Bad Request", etc.); we only care about
  // the numeric form here — leave anything else as 200 (success).
  return 200;
}

/**
 * Build the response body for a non-2xx response.
 *
 * Backwards-compatibility note: several existing routes return
 * `{ error, expected_offset }`, `{ error, retry_after_seconds }`, etc., and
 * the Apple/Web clients read those extras at the top level. To avoid
 * breaking those contracts in this change, the strategy is purely
 * additive — for the common case where the route already returned an
 * object with an `error: string`, we keep every top-level key in place
 * and just inject `code` + `requestId` alongside them. Brand-new uniform
 * envelope clients can read `body.error`, `body.code`, `body.requestId`;
 * legacy clients continue to read `body.retry_after_seconds` (etc.).
 *
 * For anything else (strings, arrays, missing `error` field, NotFound, …)
 * we synthesise a clean envelope.
 */
function buildEnvelope(
  body: unknown,
  status: number,
  requestId: string,
): Record<string, unknown> {
  const code = codeForStatus(status);

  if (isObject(body)) {
    // Already-shaped envelope (built by our own onError below, or by a
    // handler that called `errorEnvelope` directly) — just patch the
    // requestId if it's missing.
    if (typeof body.code === "string" && typeof body.error === "string") {
      return {
        ...body,
        code: body.code,
        requestId:
          typeof body.requestId === "string" ? body.requestId : requestId,
      };
    }

    if (typeof body.error === "string") {
      // Legacy `{ error: "msg", ...rest }` shape. Keep `rest` at the top
      // level so existing clients (Apple/Web/backup-ingest) keep reading
      // their accustomed fields. Add `code` + `requestId` alongside.
      return {
        ...body,
        code,
        requestId,
      };
    }

    // Unstructured object with no `error` field — synthesise an envelope
    // and stash the original under `details`.
    return {
      error: "request failed",
      code,
      requestId,
      details: body,
    };
  }

  if (typeof body === "string") {
    return { error: body, code, requestId };
  }

  // No body at all (e.g. Elysia's default NotFound path).
  return { error: "request failed", code, requestId };
}

/**
 * Elysia plugin. Mount once at the root of `buildApp`.
 *
 * Adds two derived fields to the route context:
 *   - `requestId: string` — the stable id (echoed from `X-Request-Id`
 *     inbound header, or freshly generated).
 *   - `log: Logger` — a pino child bound to `{ requestId, method, path }`,
 *     so any handler that calls `log.warn(...)` gets the id for free.
 */
export const requestContext = new Elysia({ name: "requestContext" })
  // onRequest fires before derive and before any route handler. Stash the
  // request-id on `store` so it's accessible from every later lifecycle
  // hook (`onError`, `mapResponse`) — those don't see `derive`d fields.
  .onRequest(({ request, set, store }) => {
    const inbound = request.headers.get("x-request-id");
    const requestId =
      inbound && inbound.length > 0 && inbound.length <= 128
        ? inbound
        : randomUUID();
    // Mutating store at request scope is fine — Elysia gives each request
    // its own context. (See Elysia docs: "store is per-instance, derive is
    // per-request"; here we use store because onError/mapResponse need it
    // and they bypass derive's context.)
    (store as Record<string, unknown>).requestId = requestId;
    set.headers["X-Request-Id"] = requestId;
  })
  // derive runs after onRequest. Expose `requestId` + a bound logger to
  // handlers via destructuring.
  .derive(({ store, request }) => {
    const requestId =
      (store as Record<string, unknown>).requestId as string | undefined;
    const id = requestId ?? randomUUID();
    const log: Logger = childLogger("request").child({
      requestId: id,
      method: request.method,
      path: new URL(request.url).pathname,
    });
    return { requestId: id, log };
  })
  // onError catches thrown errors. Writes a fresh envelope and preserves
  // any pre-set `set.status` so middleware-imposed codes (e.g. 401 from
  // requireAuth) still surface to the client.
  .onError(({ error, set, request, store, code }) => {
    const requestId =
      ((store as Record<string, unknown>).requestId as string | undefined) ??
      randomUUID();
    const log = childLogger("request").child({
      requestId,
      method: request.method,
      path: new URL(request.url).pathname,
    });

    const message = error instanceof Error ? error.message : String(error);

    // Map Elysia's built-in error codes (VALIDATION from TypeBox, NOT_FOUND
    // from unmatched routes, etc.) to HTTP statuses when set.status hasn't
    // already been pinned by an upstream `set.status = N`.
    const preset = statusAsNumber(set.status);
    let status: number;
    if (preset >= 400 && preset < 600) {
      status = preset;
    } else if (code === "VALIDATION") {
      status = 422;
    } else if (code === "NOT_FOUND") {
      status = 404;
    } else if (code === "PARSE") {
      status = 400;
    } else {
      status = 500;
    }
    set.status = status;

    // Preserve the legacy DB-unavailable carve-out: surface the helpful
    // "start mongo" tip at the top level so operators (and any existing
    // diagnostic UI) still see it. The envelope-mandated `code` + `requestId`
    // are added alongside.
    const isDbErr = message.includes("[db]") || message.includes("MongoDB");
    if (isDbErr && status >= 500) {
      set.status = 503;
      log.error({ err: error }, "request error (db unavailable)");
      return {
        error: "Database unavailable",
        code: "service_unavailable" as ErrorCode,
        requestId,
        detail: message,
        tip: "Start MongoDB with: docker compose up -d mongo",
      };
    }

    // Pass the raw error to pino so its serializer preserves the stack +
    // any structured fields (e.g. MongoDB driver error codes).
    log.error({ err: error }, "request error");

    const envelope: ErrorEnvelope = {
      error: message,
      code: codeForStatus(status),
      requestId,
    };
    return envelope;
  })
  // mapResponse runs after every successful return AND after onError, BEFORE
  // serialization. Routes that did `set.status = 400; return { error: "..." }`
  // (without throwing) bypass onError entirely — they land here, where we
  // rewrap them in the envelope so the schema is uniform end-to-end.
  //
  // IMPORTANT: returning `undefined` from mapResponse clears the body in
  // Elysia 1.4 (it assigns `_r = undefined` after our hook). So for the
  // pass-through cases — 2xx, raw Response objects, already-envelope —
  // we explicitly return the original response. Only the rewrap path
  // returns a new value.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  .mapResponse(((ctx: any) => {
    // mapResponse's typed signature ties `response` to the route schema
    // tree, which is `{}` on a freshly-instantiated plugin — leading to
    // "unknown not assignable" errors when we return something. We operate
    // generically across every route here, so we accept `any` at the
    // registration boundary and introspect freely below.
    const response: unknown = ctx.response;
    const set = ctx.set;
    const store = ctx.store as Record<string, unknown>;
    const status = statusAsNumber(set.status);

    // Success / redirect: pass through.
    if (status < 400 || status >= 600) return response;

    // Raw Response objects (file streams, etc.) own their own shape;
    // pass them through untouched. The envelope only covers JSON errors.
    if (response instanceof Response) return response;

    // Already-an-envelope short-circuit (built by our onError above, or
    // by the `errorEnvelope` helper).
    if (
      isObject(response) &&
      typeof response.code === "string" &&
      typeof response.error === "string" &&
      typeof response.requestId === "string"
    ) {
      return response;
    }

    const requestId =
      (store.requestId as string | undefined) ?? randomUUID();
    const envelope = buildEnvelope(response, status, requestId);
    return envelope;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  }) as any)
  // Promote the plugin's hooks to global scope so they cover every route
  // mounted on the parent app (including sub-apps and the static-UI
  // catch-all). Elysia 1.4 picks up the `.as("global")` modifier as the
  // public API for this; the per-hook `{ as: "global" }` option is buggy
  // in this version (it stores the handler in a way that crashes the
  // composer — see PR for #133).
  .as("global");

/**
 * Helper for handlers that want to build the envelope explicitly — kept
 * exported so future routes don't have to know the field names.
 */
export function errorEnvelope(
  status: number,
  message: string,
  requestId: string,
  details?: Record<string, unknown>,
): ErrorEnvelope {
  return {
    error: message,
    code: codeForStatus(status),
    requestId,
    ...(details ? { details } : {}),
  };
}
