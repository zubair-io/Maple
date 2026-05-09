/**
 * /api/indexer routes — supervisor lifecycle + pipeline proxy.
 *
 * The old pipeline architecture (standalone child + control.ts supervisor)
 * has been retired in favour of the stage-controllers supervisor
 * (src/api/src/workers/supervisor.ts). This file is a transitional stub:
 *
 *   - Lifecycle endpoints (start / stop / process) now reflect the new
 *     supervisor's state via supervisorState().
 *   - Proxy endpoints (/status, /config, /pause, /resume, /dead-letter,
 *     /exif-backfill, /enqueue, /rescan/:folderId) return 501 until
 *     Task 10 wires them to the appropriate stage-controller IPC channels.
 *
 * TODO(Task 10): Replace 501 stubs with supervisor IPC calls.
 */

import { Elysia } from "elysia";
import { supervisorState } from "../workers/supervisor.ts";

/** 501 stub for proxy endpoints pending Task 10. */
function notImplemented(endpoint: string): Response {
  return new Response(
    JSON.stringify({
      error: "Not implemented",
      detail: `${endpoint} is pending Task 10 (supervisor IPC wiring).`,
    }),
    {
      status: 501,
      headers: { "content-type": "application/json" },
    },
  );
}

export const indexerRoutes = new Elysia({ prefix: "/api/indexer" })
  // ── Proxy endpoints (501 stubs — Task 10) ───────────────────────────────
  .get("/status", () => notImplemented("GET /api/indexer/status"))
  .put("/config", () => notImplemented("PUT /api/indexer/config"))
  .post("/pause", () => notImplemented("POST /api/indexer/pause"))
  .post("/resume", () => notImplemented("POST /api/indexer/resume"))
  .get("/dead-letter", () => notImplemented("GET /api/indexer/dead-letter"))
  .get("/dead-letter/groups", () =>
    notImplemented("GET /api/indexer/dead-letter/groups"),
  )
  .post("/dead-letter/reset", () =>
    notImplemented("POST /api/indexer/dead-letter/reset"),
  )
  .post("/exif-backfill", () => notImplemented("POST /api/indexer/exif-backfill"))
  .post("/enqueue", () => notImplemented("POST /api/indexer/enqueue"))
  .post("/rescan/:folderId", () =>
    notImplemented("POST /api/indexer/rescan/:folderId"),
  )

  // ── Lifecycle endpoints (wired to new supervisor) ────────────────────────
  //
  // The new supervisor manages stage-controller children (not a monolithic
  // indexer child), so start/stop here are stubs that surface supervisor
  // state. Full lifecycle control is at /api/workers/:name/*.
  .post("/start", () => {
    const state = supervisorState();
    return { ok: true, state };
  })

  .post("/stop", () => {
    const state = supervisorState();
    return { ok: true, state };
  })

  .get("/process", () => supervisorState());
