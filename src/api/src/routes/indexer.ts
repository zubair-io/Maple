/**
 * /api/indexer routes — supervisor lifecycle + pipeline proxy.
 *
 * These routes keep the existing Angular UI working while Plan 4 redesigns
 * the settings surface into /settings/workers. Routes that have a clear
 * supervisor translation are wired; routes that are genuinely deprecated or
 * not yet re-implemented return 501 with a descriptive message.
 *
 * Translations:
 *   GET  /status              → supervisorState() (stage-controller statuses)
 *   POST /pause               → pauseSupervisor() (all stages)
 *   POST /resume              → resumeSupervisor() (all stages)
 *   POST /start               → startSupervisor({ stages: ["hash","exif","thumb"] })
 *   POST /stop                → stopSupervisor()
 *   GET  /process             → supervisorState()
 *   PUT  /config              → 501 (per-stage config is at /api/workers/:name/config)
 *   GET  /dead-letter         → 501 (Plan 3)
 *   GET  /dead-letter/groups  → 501 (Plan 3)
 *   POST /dead-letter/reset   → 501 (Plan 3)
 *   POST /exif-backfill       → 501 (version-bump is the new mechanism)
 *   POST /enqueue             → 501 (discover watcher replaces manual enqueue)
 *   POST /rescan/:folderId    → 501 (Plan 3)
 */

import { Elysia } from "elysia";
import {
  startSupervisor,
  stopSupervisor,
  supervisorState,
  pauseSupervisor,
  resumeSupervisor,
} from "../workers/supervisor.ts";

/** 501 stub for routes pending a future plan. */
function notImplemented(endpoint: string, movedTo?: string): Response {
  const body: Record<string, string> = {
    error: "Not implemented",
    detail: `${endpoint} has no equivalent in the new supervisor architecture.`,
  };
  if (movedTo) body.movedTo = movedTo;
  return new Response(JSON.stringify(body), {
    status: 501,
    headers: { "content-type": "application/json" },
  });
}

export const indexerRoutes = new Elysia({ prefix: "/api/indexer" })
  // ── Status ───────────────────────────────────────────────────────────────
  // Returns the supervisor's per-stage status map. The Angular UI reads this
  // to display running/stopped/error states for the pipeline stages.
  .get("/status", () => supervisorState())

  // ── Pause / Resume ───────────────────────────────────────────────────────
  // Pause/resume all stage children via their IPC ports.
  .post("/pause", async () => {
    await pauseSupervisor();
    return { ok: true };
  })

  .post("/resume", async () => {
    await resumeSupervisor();
    return { ok: true };
  })

  // ── Lifecycle ────────────────────────────────────────────────────────────
  // Start/stop the supervisor. Typically the supervisor is auto-started by
  // index.ts on boot; these endpoints allow manual control.
  .post("/start", async () => {
    await startSupervisor({ stages: ["hash", "exif", "thumb"] });
    return supervisorState();
  })

  .post("/stop", async () => {
    await stopSupervisor();
    return { ok: true };
  })

  // /process mirrors /status — kept for backwards compat with the old
  // control.ts proxy shape which the Angular UI reads in some places.
  .get("/process", () => supervisorState())

  // ── Deprecated / Plan 4 ─────────────────────────────────────────────────
  // Per-stage config is now at PATCH /api/workers/:name/config.
  .put("/config", () =>
    notImplemented("PUT /api/indexer/config", "PATCH /api/workers/:name/config"),
  )

  // Dead-letter queues are re-implemented in Plan 3.
  .get("/dead-letter", () =>
    // TODO Plan 4: implement via stage dead-letter collection query
    notImplemented("GET /api/indexer/dead-letter"),
  )
  .get("/dead-letter/groups", () =>
    // TODO Plan 4: implement via stage dead-letter collection query
    notImplemented("GET /api/indexer/dead-letter/groups"),
  )
  .post("/dead-letter/reset", () =>
    // TODO Plan 4: implement via stage dead-letter reset
    notImplemented("POST /api/indexer/dead-letter/reset"),
  )

  // EXIF backfill is now handled by bumping the exif stage's targetVersion.
  .post("/exif-backfill", () =>
    notImplemented("POST /api/indexer/exif-backfill"),
  )

  // Manual enqueue is replaced by the discover watcher which upserts docs
  // automatically when files appear on disk.
  .post("/enqueue", () =>
    notImplemented("POST /api/indexer/enqueue"),
  )

  // Rescan a folder — Plan 3 will implement this as a supervisor IPC call
  // that re-walks the folder and upserts any missing docs.
  .post("/rescan/:folderId", () =>
    // TODO Plan 4: route to supervisor discover rescan
    notImplemented("POST /api/indexer/rescan/:folderId"),
  );
