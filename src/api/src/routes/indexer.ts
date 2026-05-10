/**
 * /api/indexer routes — supervisor lifecycle + pipeline proxy.
 *
 * These routes keep the existing Angular UI working while Plan 4 redesigns
 * the settings surface into /settings/workers. All routes return the legacy
 * IndexerStatus / IndexerLifecycleResponse / IndexerProcessState shapes that
 * the Angular settings page at /settings/indexer expects.
 *
 * Translations:
 *   GET  /status              → toLegacyStatus()
 *   POST /pause               → pauseSupervisor() + toLegacyStatus()
 *   POST /resume              → resumeSupervisor() + toLegacyStatus()
 *   POST /start               → startSupervisor({ stages }) + IndexerLifecycleResponse
 *   POST /stop                → stopSupervisor() + IndexerLifecycleResponse
 *   GET  /process             → toLegacyProcessState()
 *   PUT  /config              → per-stage concurrency update + toLegacyStatus()
 *   GET  /dead-letter         → 501 (Plan 3)
 *   GET  /dead-letter/groups  → 501 (Plan 3)
 *   POST /dead-letter/reset   → 501 (Plan 3)
 *   POST /enqueue             → 501 (discover watcher replaces manual enqueue)
 *   POST /rescan/:folderId    → updateMany stages.*.version=0 for all assets under the folder path
 */

import { Elysia, t } from "elysia";
import { ObjectId } from "mongodb";
import {
  startSupervisor,
  stopSupervisor,
  supervisorState,
  pauseSupervisor,
  resumeSupervisor,
  type StageProcessState,
} from "../workers/supervisor.ts";
import { assetsCollection, foldersCollection } from "../db/client.ts";
import { stageManifest } from "../workers/stages/manifest.ts";
import { child as childLogger } from "../log.ts";

const log = childLogger("indexer-routes");

// ---------------------------------------------------------------------------
// Legacy shape constants — the six stage names the Angular UI knows about.
// ---------------------------------------------------------------------------

const LEGACY_STAGES = ["discover", "hash", "exif", "thumb", "ai", "mongo"] as const;
type LegacyStage = (typeof LEGACY_STAGES)[number];

interface LegacyStageCounters {
  inFlight: number;
  errors: number;
  deadLetter: number;
}

interface LegacyChannelInfo {
  depth: number;
  capacity: number;
}

interface LegacyIndexerStatus {
  paused: boolean;
  pools: Record<LegacyStage, number>;
  channels: Record<LegacyStage, LegacyChannelInfo>;
  stages: Record<LegacyStage, LegacyStageCounters>;
  started: boolean;
}

interface LegacyProcessState {
  status: "stopped" | "starting" | "running" | "crashed" | "restarting";
  pid: number | null;
  lastStartedAt: string | null;
  lastExitCode: number | null;
  lastError: string | null;
  restartCount: number;
}

interface IndexerLifecycleResponse {
  ok: boolean;
  state: LegacyProcessState;
  error?: string;
}

/**
 * Map a new StageProcessState.status value to the legacy
 * IndexerProcessState.status enum (which has "crashed" instead of "error").
 */
function toLegacyStageStatus(
  s: StageProcessState["status"],
): LegacyProcessState["status"] {
  if (s === "error") return "crashed";
  return s as LegacyProcessState["status"];
}

/**
 * Build a legacy IndexerStatus from the current supervisor state.
 * All six legacy stage keys are always populated; stages unknown to the
 * new supervisor are synthesised with zero counters.
 */
function toLegacyStatus(): LegacyIndexerStatus {
  const state = supervisorState();

  const pools = {} as Record<LegacyStage, number>;
  const channels = {} as Record<LegacyStage, LegacyChannelInfo>;
  const stages = {} as Record<LegacyStage, LegacyStageCounters>;

  let anyRunning = false;
  let anyPaused = false;

  for (const name of LEGACY_STAGES) {
    const s = state[name] as StageProcessState | undefined;
    if (s) {
      if (s.status === "running") anyRunning = true;
      pools[name] = s.inFlight > 0 ? s.inFlight : 1;
      channels[name] = { depth: 0, capacity: 0 };
      stages[name] = { inFlight: s.inFlight, errors: 0, deadLetter: 0 };
    } else {
      // Stage not registered in new supervisor — synthesise zeros.
      pools[name] = 0;
      channels[name] = { depth: 0, capacity: 0 };
      stages[name] = { inFlight: 0, errors: 0, deadLetter: 0 };
    }
  }

  // paused = true only if there are running stages and none are actually
  // processing (proxy: all known stages are in stopped/error state).
  const stateValues = Object.values(state);
  if (stateValues.length > 0 && stateValues.every((s) => s.status === "stopped" || s.status === "error")) {
    anyPaused = true;
  }

  return {
    paused: anyPaused && !anyRunning,
    pools,
    channels,
    stages,
    started: anyRunning || stateValues.some((s) => s.status === "starting" || s.status === "restarting"),
  };
}

/**
 * Build a legacy IndexerProcessState (aggregate view of all stage children).
 * Reports the "worst" status across all stages: error > restarting > starting > running > stopped.
 */
function toLegacyProcessState(): LegacyProcessState {
  const state = supervisorState();
  const entries = Object.values(state);
  if (entries.length === 0) {
    return {
      status: "stopped",
      pid: null,
      lastStartedAt: null,
      lastExitCode: null,
      lastError: null,
      restartCount: 0,
    };
  }

  // Priority order: error > restarting > starting > running > stopped
  const priority: Record<string, number> = {
    error: 5,
    restarting: 4,
    starting: 3,
    running: 2,
    stopped: 1,
  };

  let worst = entries[0];
  for (const e of entries) {
    if ((priority[e.status] ?? 0) > (priority[worst.status] ?? 0)) {
      worst = e;
    }
  }

  return {
    status: toLegacyStageStatus(worst.status),
    pid: worst.pid,
    lastStartedAt: worst.lastStartedAt,
    lastExitCode: worst.lastExitCode,
    lastError: worst.lastError,
    restartCount: entries.reduce((sum, e) => sum + e.restartCount, 0),
  };
}

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
  // Returns the full legacy IndexerStatus shape the Angular settings page
  // expects, translated from the new supervisor's per-stage process state.
  .get("/status", () => toLegacyStatus())

  // ── Pause / Resume ───────────────────────────────────────────────────────
  // Pause/resume all stage children via their IPC ports.
  // Returns { ok, status } as the Angular client expects.
  .post("/pause", async () => {
    await pauseSupervisor();
    return { ok: true, status: toLegacyStatus() };
  })

  .post("/resume", async () => {
    await resumeSupervisor();
    return { ok: true, status: toLegacyStatus() };
  })

  // ── Lifecycle ────────────────────────────────────────────────────────────
  // Start/stop the supervisor. Returns IndexerLifecycleResponse.
  .post("/start", async () => {
    await startSupervisor({ stages: ["hash", "exif", "thumb"] });
    const response: IndexerLifecycleResponse = {
      ok: true,
      state: toLegacyProcessState(),
    };
    return response;
  })

  .post("/stop", async () => {
    await stopSupervisor();
    const response: IndexerLifecycleResponse = {
      ok: true,
      state: toLegacyProcessState(),
    };
    return response;
  })

  // /process returns the aggregate legacy IndexerProcessState.
  .get("/process", () => toLegacyProcessState())

  // ── Config ───────────────────────────────────────────────────────────────
  // Translate per-stage pool-size updates from the Angular UI into per-stage
  // WorkerConfig patches. Body: { workers: { hash: 4, exif: 2, ... } }
  // (the UI sends "workers" as the key based on the setIndexerWorkers call).
  .put(
    "/config",
    async ({ body }) => {
      // Lazily import to avoid circular deps.
      const { getDb } = await import("../db/client.ts");
      const { WorkerConfigRepo } = await import("../workers/worker-config.repo.ts");

      const workers = (body as { workers?: Partial<Record<string, number>> }).workers ?? {};
      try {
        const db = await getDb();
        const coll = db.collection("worker_config");
        const repo = new WorkerConfigRepo(coll as never);
        for (const [stage, concurrency] of Object.entries(workers)) {
          if (typeof concurrency === "number") {
            await repo.patch(stage, { concurrency });
          }
        }
      } catch {
        // Non-fatal: DB may be unavailable; return current status anyway.
      }
      return { ok: true, status: toLegacyStatus() };
    },
    {
      body: t.Object({
        workers: t.Optional(t.Record(t.String(), t.Number())),
      }),
    },
  )

  // ── Deprecated / Plan 4 ─────────────────────────────────────────────────
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

  // Manual enqueue is replaced by the discover watcher which upserts docs
  // automatically when files appear on disk.
  .post("/enqueue", () =>
    notImplemented("POST /api/indexer/enqueue"),
  )

  // Rescan a folder — resets stages.*.version to 0 (and clears dead/attempts/
  // last_error) for every asset doc whose abs_path is under the folder's path
  // tree. The stage controllers pick them up on their next poll cycle.
  .post(
    "/rescan/:folderId",
    async ({ params, set }) => {
      const folderIdStr = params.folderId;
      if (!ObjectId.isValid(folderIdStr)) {
        set.status = 400;
        return { ok: false, error: "Invalid folderId" };
      }
      const id = new ObjectId(folderIdStr);
      const folders = await foldersCollection();
      const folder = await folders.findOne({ _id: id });
      if (!folder) {
        set.status = 404;
        return { ok: false, error: "Folder not found" };
      }
      const scanRoot = folder.path;

      // Build the $set payload: zero every stage's version and clear
      // dead/attempts/last_error so the claim query picks the docs back up.
      const stageResetFields: Record<string, unknown> = {};
      for (const stage of stageManifest) {
        stageResetFields[`stages.${stage.name}.version`] = 0;
        stageResetFields[`stages.${stage.name}.dead`] = false;
        stageResetFields[`stages.${stage.name}.attempts`] = 0;
        stageResetFields[`stages.${stage.name}.last_error`] = null;
      }

      // Escape special regex chars in the path before embedding it.
      const escapedRoot = scanRoot.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const assets = await assetsCollection();
      const updateResult = await (assets as import("mongodb").Collection<import("mongodb").Document>).updateMany(
        { abs_path: { $regex: `^${escapedRoot}/` } },
        { $set: stageResetFields },
      );

      log.info(
        { folderId: folderIdStr, path: scanRoot, modified: updateResult.modifiedCount },
        "rescan: stage versions zeroed",
      );

      return { ok: true, folderId: folderIdStr, path: scanRoot, reset: updateResult.modifiedCount };
    },
  );
