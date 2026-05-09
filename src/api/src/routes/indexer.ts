/**
 * /api/indexer routes — proxy + supervisor lifecycle.
 *
 * Pipeline-touching endpoints (status / config / pause / resume / dead-letter
 * / exif-backfill) are forwarded to the standalone indexer child process
 * over `127.0.0.1:${MAPLE_INDEXER_PORT}`. The parent never touches the
 * pipeline directly anymore — see `src/indexer/control.ts` for the
 * supervisor and `src/indexer/standalone.ts` for the child entrypoint.
 *
 * Lifecycle endpoints (start / stop / process) talk to the local
 * supervisor instead of the child:
 *   POST /api/indexer/start     — spawn the child + waitReady()
 *   POST /api/indexer/stop      — SIGTERM the child (forced fallback)
 *   GET  /api/indexer/process   — supervisor `state()` snapshot
 *
 * The `requireAuth` middleware sits at the parent-app level
 * (`new Elysia({name:"authedApi"}).use(requireAuth).use(indexerRoutes)`),
 * so every route below is bearer-gated.
 */

import { Elysia } from "elysia";
import {
  spawnChild,
  stopChild,
  waitReady,
  state as controlState,
  targetUrl,
} from "../indexer/control.ts";

/**
 * Forward an incoming `Request` to the child indexer's matching path.
 * Streams the body through; preserves the `content-type` header (and
 * a couple of other safe ones) on the way back. Bails with a 503 if
 * the supervisor reports the child isn't running.
 */
async function proxy(req: Request, childPath: string): Promise<Response> {
  const st = controlState();
  if (st.status !== "running" && st.status !== "starting") {
    return new Response(
      JSON.stringify({
        error: "Indexer process is not running",
        state: st,
      }),
      {
        status: 503,
        headers: { "content-type": "application/json" },
      },
    );
  }

  // Preserve query string from the original URL.
  const incoming = new URL(req.url);
  const target = new URL(targetUrl(childPath));
  target.search = incoming.search;

  // Build the upstream request. Drop hop-by-hop and identity headers — we're
  // re-targeting the request to a different origin.
  const headers = new Headers();
  for (const [k, v] of req.headers) {
    const lower = k.toLowerCase();
    if (
      lower === "host" ||
      lower === "connection" ||
      lower === "content-length" ||
      lower === "authorization" // child is localhost-only; parent already auth'd
    ) {
      continue;
    }
    headers.set(k, v);
  }

  // For methods that may carry a body, forward it as-is. `fetch` will
  // re-encode it; the simplest reliable path is to read once.
  const method = req.method;
  let body: BodyInit | undefined;
  if (method !== "GET" && method !== "HEAD") {
    const buf = await req.arrayBuffer();
    if (buf.byteLength > 0) body = buf;
  }

  let upstream: Response;
  try {
    upstream = await fetch(target.toString(), {
      method,
      headers,
      body,
      // 30s safety net — keeps a stalled child from hanging the parent loop.
      signal: AbortSignal.timeout(30_000),
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return new Response(
      JSON.stringify({
        error: "Indexer process unreachable",
        detail: msg,
        state: controlState(),
      }),
      {
        status: 502,
        headers: { "content-type": "application/json" },
      },
    );
  }

  // Forward the response. Preserve content-type + content-encoding + cache-related
  // headers — strip the rest so we don't accidentally leak hop-by-hop / connection-
  // specific headers from the child.
  const outHeaders = new Headers();
  const ct = upstream.headers.get("content-type");
  if (ct) outHeaders.set("content-type", ct);
  const ce = upstream.headers.get("content-encoding");
  if (ce) outHeaders.set("content-encoding", ce);
  const cc = upstream.headers.get("cache-control");
  if (cc) outHeaders.set("cache-control", cc);

  return new Response(upstream.body, {
    status: upstream.status,
    headers: outHeaders,
  });
}

export const indexerRoutes = new Elysia({ prefix: "/api/indexer" })
  // ── Proxy endpoints ──────────────────────────────────────────────────────
  // We deliberately don't validate body/query at the parent — the child
  // does, and the parent should be a thin pass-through so child schema
  // updates don't require a parent rebuild.
  .get("/status", ({ request }) => proxy(request, "/status"))
  .put("/config", ({ request }) => proxy(request, "/config"))
  .post("/pause", ({ request }) => proxy(request, "/pause"))
  .post("/resume", ({ request }) => proxy(request, "/resume"))
  .get("/dead-letter", ({ request }) => proxy(request, "/dead-letter"))
  .get("/dead-letter/groups", ({ request }) =>
    proxy(request, "/dead-letter/groups"),
  )
  .post("/dead-letter/reset", ({ request }) =>
    proxy(request, "/dead-letter/reset"),
  )
  .post("/exif-backfill", ({ request }) => proxy(request, "/exif-backfill"))
  .post("/enqueue", ({ request }) => proxy(request, "/enqueue"))
  .post("/rescan/:folderId", ({ request, params }) =>
    proxy(request, `/rescan/${encodeURIComponent(params.folderId)}`),
  )

  // ── Lifecycle endpoints (local — supervisor) ─────────────────────────────
  .post("/start", async () => {
    const st = controlState();
    if (st.status === "running") return { ok: true, state: st };
    spawnChild();
    try {
      await waitReady();
      return { ok: true, state: controlState() };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return {
        ok: false,
        error: msg,
        state: controlState(),
      };
    }
  })

  .post("/stop", async () => {
    await stopChild({ graceful: true });
    return { ok: true, state: controlState() };
  })

  .get("/process", () => controlState());
