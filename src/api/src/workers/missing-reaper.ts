/**
 * Missing-file reaper — reconciles per-LOCATION `missing_since` tags: recovers
 * a location whose file reappeared, prunes one whose file is confirmed gone,
 * and hard-deletes the asset record once no location remains.
 *
 * Lifecycle (per `fileinfo[]` entry, not per asset):
 *   1. TAG (automatic). The discover `removed` handler stamps
 *      `fileinfo[i].missing_since` when a file is unlinked; a file-touching
 *      stage (exif/thumb/preview) stamps it on the primary entry when it
 *      ENOENTs (see `tagMissingSince` in `./tag-missing.ts`); the
 *      modified-content guard dual-flags an orphaned entry. Tagging is the only
 *      automatic step. A tagged entry is non-live, so the asset drops out of
 *      reads + stage claims the moment its LAST live entry is tagged.
 *   2. REAP. This worker scans rows with any tagged entry each tick, re-stats
 *      each tagged location, and either recovers it (clear the tag), `$pull`s
 *      it once aged past the prune window, or — when the `$pull` empties the
 *      row — hard-deletes the record (emitting a `delete` change event).
 *
 * Safety properties, all load-bearing:
 *
 *   - Controlled like every other worker. Its paused state lives in
 *     `worker_config.paused`; pause/resume persist it, so a pause STICKS across
 *     restarts. But "paused" suspends ONLY the irreversible record delete —
 *     recovery and sibling-prune of SURVIVING rows keep running every tick, so
 *     a moved/re-copied file reconciles even while paused. On boot it stays
 *     paused only until the stored state is read, so a config-store blip can't
 *     run a sweep against an operator's prior pause.
 *
 *   - Age window (cool-down), not a boot gate. A tagged entry is `$pull`ed —
 *     and the record deleted if it was the last — only once that entry has been
 *     missing for at least `prune_window_hours` (default 12h, in
 *     `app_settings`, env `MAPLE_REAPER_PRUNE_HOURS`). Per-entry, so a freshly
 *     missing sibling can't drag an aged one's clock, nor vice-versa. This
 *     bounds how fast a transient mass-unmount turns into deletions. Recovery
 *     is never age-gated.
 *
 *   - Mount guard. If a tagged location's library root is unregistered, its
 *     mount point isn't present, or the path can't be stat'd, the row is
 *     SKIPPED this pass (never pruned/deleted). A whole offline share must not
 *     be mistaken for a pile of deleted files.
 *
 *   - Name-mismatch veto. Before the irreversible record delete, each gone
 *     location's parent dir is listed; a case/Unicode near-match means the file
 *     is on disk under a different name (a stored-path bug), so the row is
 *     SKIPPED for inspection rather than deleted.
 *
 *   - Circuit breaker. A pass that would hard-delete a large fraction of what
 *     it scanned aborts WITHOUT deleting — a systemic mis-detection guard.
 *
 * Per-entry classification each pass:
 *   - A `deleted_at` tagged entry (content replaced in place — an orphan) is
 *     dead: NOT re-stat'd (a different file may sit at the path) and not
 *     near-match vetoed; it is simply `$pull`ed once aged.
 *   - A `missing_since`-only entry is re-stat'd: present → recover (clear the
 *     tag); absent + aged → prune; absent + cooldown → left; offline/unreadable
 *     → row skipped.
 *   - A row keeps any LIVE or not-yet-aged entry → it SURVIVES (recover + prune
 *     its dead siblings; re-arm dead original-file stages so they reprocess).
 *   - Only when every entry is gone-and-aged (and no veto) is the record
 *     hard-deleted.
 *
 * Registered into the in-process `stageRegistry` so the existing
 * `/api/workers/missing-reaper/{status,pause,resume}` surface controls it,
 * the same as every pipeline stage. It is NOT a version-claim stage, so it
 * runs its own interval loop (mirrors `trash-gc`) rather than `runStage()`.
 * Started from `src/index.ts`.
 */

import * as path from "node:path";
import type { ObjectId } from "mongodb";
import { assetsCollection } from "../db/client.ts";
import { loadLibraryRoots } from "../indexer/libraries.cache.ts";
import { recordAndPublishAssetChange } from "../db/changes.repo.ts";
import { meilisearchClient } from "../enrichment/meilisearch-client.ts";
import { updateLiveLocationCount } from "../indexer/images.repo.ts";
import { cleanPreviewsCacheForLocation } from "../fs/xmp.ts";
import type { FileInfo } from "../db/schema.ts";
import { child as childLogger } from "../log.ts";
import { stageRegistry } from "./registry.ts";
import { ThroughputWindow } from "./run-stage.ts";
import {
  WorkerConfigRepo,
  type WorkerConfigDoc,
} from "./worker-config.repo.ts";
import { loadPruneWindowHours } from "./missing-reaper-config.repo.ts";
import {
  BREAKER_FRACTION,
  BREAKER_MIN,
  hasLiveEntry,
  missingFileInfos,
  nearMatchOnDisk,
  reArmDeadStages,
  sameEntry,
  statKind,
  type MissingReaperSummary,
} from "./missing-reaper.helpers.ts";
import { makePausedPoller } from "./paused-poller.ts";

const log = childLogger("missing-reaper");

/** Registry / route key. Matches `/api/workers/missing-reaper/...`. */
export const MISSING_REAPER_NAME = "missing-reaper";

const DEFAULT_INTERVAL_MS = 60_000;
const DEFAULT_BATCH = 200;

export interface RunMissingReaperOptions {
  /** Max tagged rows to examine in one pass. */
  batchSize?: number;
  /**
   * Hard-delete an all-gone row only if its `missing_since` is strictly before
   * this ISO timestamp — i.e. it has been missing for at least the prune
   * window. The interval loop passes `now - pruneWindowHours`. Recovery/prune
   * of rows whose file is still present is NOT gated by this.
   */
  deleteBeforeIso: string;
  /**
   * When false, eligible deletes are skipped (counted `skippedPaused`) but
   * recovery/prune still runs — so a re-found file reconciles even while the
   * reaper is "paused". The loop passes `!paused`. Defaults to true.
   */
  allowDelete?: boolean;
}

/** One reap pass. Exported for tests + driven by the interval loop. */
export async function runMissingReaperOnce(
  opts: RunMissingReaperOptions,
): Promise<MissingReaperSummary> {
  const batchSize = opts.batchSize ?? DEFAULT_BATCH;
  const coll = await assetsCollection();

  let libs: ReadonlyMap<string, string>;
  try {
    libs = await loadLibraryRoots();
  } catch {
    libs = new Map();
  }

  // Per-pass root cache: unregistered/missing roots count as offline → assets skipped.
  const rootStatus = new Map<string, "present" | "offline">();
  const checkRoot = async (
    libIdHex: string,
  ): Promise<"present" | "offline"> => {
    const cached = rootStatus.get(libIdHex);
    if (cached) return cached;
    const root = libs.get(libIdHex);
    let status: "present" | "offline";
    if (!root) {
      status = "offline";
    } else {
      status = (await statKind(root)) === "present" ? "present" : "offline";
    }
    rootStatus.set(libIdHex, status);
    return status;
  };

  const allowDelete = opts.allowDelete ?? true;
  const summary: MissingReaperSummary = {
    scanned: 0,
    reaped: 0,
    recovered: 0,
    prunedEntries: 0,
    skippedMountOffline: 0,
    skippedNameMismatch: 0,
    skippedCooldown: 0,
    skippedPaused: 0,
    aborted: false,
    errors: 0,
  };

  // Every row with a tagged entry is examined each pass (no boot gate) —
  // recovery is prompt. The age window + pause only gate the irreversible
  // record delete below. `$type: "string"` lets the planner use the
  // `fileinfo.missing_since_1` partial multikey index instead of a COLLSCAN.
  const candidates = await coll
    .find(
      { "fileinfo.missing_since": { $type: "string" } },
      {
        projection: {
          _id: 1,
          fileinfo: 1,
          maple_id: 1,
          // Dead flags for the original-file stages — so recovery can re-arm
          // ones that dead-lettered against the vanished path (drains the
          // legacy backlog from before tag-only suppression).
          "stages.exif.dead": 1,
          "stages.thumb.dead": 1,
          "stages.preview.dead": 1,
        },
      },
    )
    // Oldest-missing first. A multikey sort orders by each row's smallest
    // entry `missing_since`, so the longest-waiting rows are reconciled first
    // even when a backlog exceeds `batchSize`.
    .sort({ "fileinfo.missing_since": 1 })
    .limit(batchSize)
    .toArray();

  // Defer record deletes: classify all candidates first, then gate on the breaker.
  const toDelete: typeof candidates = [];

  for (const doc of candidates) {
    summary.scanned++;
    try {
      const tagged = missingFileInfos(doc.fileinfo);
      const recover: FileInfo[] = []; // present again → clear missing_since
      const prune: FileInfo[] = []; // confirmed gone (or orphan) AND aged → $pull
      // Aged + absent + non-orphan entries needing a near-match veto before any
      // record delete. (Orphan/`deleted_at` entries skip the veto: a different
      // file may legitimately sit at the path, so a near-match isn't a bug.)
      const absentForVeto: FileInfo[] = [];
      let cannotVerify = false;

      for (const fi of tagged) {
        const aged = (fi.missing_since ?? "") < opts.deleteBeforeIso;
        if (fi.deleted_at) {
          // Orphan / content-moved: dead, never re-stat. Prune once aged.
          if (aged) prune.push(fi);
          continue;
        }
        // Vanished-file entry: re-stat with the mount guard.
        const libIdHex = fi.library_id.toHexString();
        if ((await checkRoot(libIdHex)) === "offline") {
          cannotVerify = true;
          break;
        }
        const root = libs.get(libIdHex)!;
        const segments = fi.path === "" ? [] : fi.path.split("/");
        const abs = path.join(root, ...segments, fi.filename);
        const kind = await statKind(abs);
        if (kind === "present") recover.push(fi);
        else if (kind === "absent") {
          if (aged) {
            prune.push(fi);
            absentForVeto.push(fi);
          }
        } else {
          // Couldn't confirm the file is gone (EACCES/EIO/…) — skip the row.
          cannotVerify = true;
          break;
        }
      }

      if (cannotVerify) {
        summary.skippedMountOffline++;
        continue;
      }

      // Survivors = every entry we are NOT pruning this pass (live entries,
      // recovered entries, and still-in-cooldown missing entries).
      const survivors = (doc.fileinfo ?? []).filter(
        (f) => !prune.some((p) => sameEntry(p, f)),
      );

      if (survivors.length > 0) {
        // The row keeps at least one location → reconcile in place (runs even
        // while paused; nothing here is irreversible). Nothing to do at all
        // when every tagged entry is still in cooldown and none recovered.
        if (recover.length === 0 && prune.length === 0) {
          if (!hasLiveEntry(doc.fileinfo)) summary.skippedCooldown++;
          continue;
        }
        await reconcileSurvivor(
          coll,
          doc,
          recover,
          prune,
          survivors,
          summary,
          libs,
        );
        continue;
      }

      // No survivor — the prune empties the row → RECORD DELETE (irreversible).
      // Near-match veto on the absent (non-orphan) entries first.
      let veto: "name-mismatch" | "unreadable" | null = null;
      for (const fi of absentForVeto) {
        const root = libs.get(fi.library_id.toHexString())!;
        const segments = fi.path === "" ? [] : fi.path.split("/");
        const verdict = await nearMatchOnDisk(
          path.join(root, ...segments, fi.filename),
        );
        if (verdict === "match") {
          veto = "name-mismatch";
          break;
        }
        if (verdict === "unreadable") {
          veto = "unreadable";
          break;
        }
      }
      if (veto === "name-mismatch") {
        summary.skippedNameMismatch++;
        log.warn(
          { _id: String(doc._id) },
          "missing-reaper: stored path ENOENT but a near-match exists on disk — skipped, not deleted",
        );
        continue;
      }
      if (veto === "unreadable") {
        // Couldn't list a gone entry's directory — treat like an offline mount:
        // skip rather than delete on unproven absence.
        summary.skippedMountOffline++;
        log.warn(
          { _id: String(doc._id) },
          "missing-reaper: gone entry parent dir unreadable — skipped, not deleted",
        );
        continue;
      }

      // Every entry is gone-and-aged (a not-yet-aged entry would be a survivor,
      // so the cooldown is already satisfied here). Gate the record delete on
      // pause; recovery/prune of surviving rows already ran above regardless.
      if (!allowDelete) {
        summary.skippedPaused++;
        continue;
      }
      toDelete.push(doc);
    } catch (err) {
      summary.errors++;
      log.warn(
        { _id: String(doc._id), err: err instanceof Error ? err.message : err },
        "missing-reaper: row failed",
      );
    }
  }

  // Circuit breaker: a pass that wants to hard-delete a large fraction of what
  // it scanned is far more likely a systemic mis-detection than that many real
  // deletions. Abort without deleting and surface it loudly.
  if (
    toDelete.length > BREAKER_MIN &&
    toDelete.length > summary.scanned * BREAKER_FRACTION
  ) {
    summary.aborted = true;
    log.error(
      { wouldDelete: toDelete.length, scanned: summary.scanned },
      "missing-reaper: circuit breaker tripped — too many hard-deletes in one pass; aborting WITHOUT deleting",
    );
    return summary;
  }

  for (const doc of toDelete) {
    try {
      await hardDeleteRow(coll, doc, libs);
      summary.reaped++;
    } catch (err) {
      summary.errors++;
      log.warn(
        { _id: String(doc._id), err: err instanceof Error ? err.message : err },
        "missing-reaper: hard-delete failed",
      );
    }
  }

  if (summary.scanned > 0) log.info(summary, "missing-reaper pass complete");
  return summary;
}

/** A surviving row (keeps ≥1 location after this pass): clear `missing_since`
 * on entries whose file reappeared, `$pull` the entries confirmed gone, and
 * re-arm any dead original-file stage so it reprocesses. `$set` (recover) and
 * `$pull` touch the same `fileinfo` path, so they cannot share one update —
 * recover runs first, then prune (+ re-arm, which is on `stages.*`, a distinct
 * path). Re-arm rides whichever update runs first. Caller guarantees at least
 * one of `recover`/`prune` is non-empty, so this always counts as one
 * recovered (surviving) row. */
async function reconcileSurvivor(
  coll: Awaited<ReturnType<typeof assetsCollection>>,
  doc: {
    _id: ObjectId;
    fileinfo?: FileInfo[];
    stages?: Record<string, { dead?: boolean }>;
  },
  recover: FileInfo[],
  prune: FileInfo[],
  survivors: FileInfo[],
  summary: MissingReaperSummary,
  libs: ReadonlyMap<string, string>,
): Promise<void> {
  // Re-arm dead stages only when a LIVE location will remain to process —
  // either an originally-live survivor, or one we are recovering this pass.
  // Re-arming while every survivor is still missing would just re-park it.
  const willHaveLive = recover.length > 0 || hasLiveEntry(survivors);
  const reArm = willHaveLive ? reArmDeadStages(doc) : {};
  let reArmApplied = false;

  if (recover.length > 0) {
    await coll.updateOne(
      { _id: doc._id },
      { $set: { "fileinfo.$[r].missing_since": null, ...reArm } },
      {
        arrayFilters: [
          {
            $or: recover.map((e) => ({
              "r.library_id": e.library_id,
              "r.path": e.path,
              "r.filename": e.filename,
            })),
          },
        ],
      },
    );
    reArmApplied = true;
  }

  if (prune.length > 0) {
    const update: Record<string, unknown> = {
      $pull: {
        fileinfo: {
          $or: prune.map((p) => ({
            library_id: p.library_id,
            path: p.path,
            filename: p.filename,
          })),
        },
      },
    };
    if (!reArmApplied && Object.keys(reArm).length > 0) update["$set"] = reArm;
    await coll.updateOne({ _id: doc._id }, update as never);
    summary.prunedEntries += prune.length;
    // Previews are path-keyed now — they don't survive a location going
    // away the way maple_id-keyed thumbs do, so clean them up right here
    // instead of leaving the orphan for cache-gc's backstop sweep.
    await cleanRemovedLocationsCache(libs, prune);
  }

  // Recompute live count after any recover/prune mutations on this row.
  await updateLiveLocationCount(coll, doc._id);
  summary.recovered++;
}

/** Best-effort previews-cache cleanup for every removed location. A
 * filesystem failure here must never affect the DB reconciliation it's
 * called alongside — cache-gc's periodic sweep reclaims anything missed. */
async function cleanRemovedLocationsCache(
  libs: ReadonlyMap<string, string>,
  entries: readonly FileInfo[],
): Promise<void> {
  await Promise.all(
    entries.map(async (fi) => {
      const root = libs.get(fi.library_id.toHexString());
      if (!root) return;
      await cleanPreviewsCacheForLocation(root, fi).catch(() => {});
    }),
  );
}

/** Hard-delete a row whose every location is gone, tombstone its search doc,
 * and publish a delete event. The row has no live entry, so route the change
 * event by its first (now-dead) fileinfo entry's library. */
async function hardDeleteRow(
  coll: Awaited<ReturnType<typeof assetsCollection>>,
  doc: { _id: ObjectId; fileinfo?: FileInfo[]; maple_id?: string },
  libs: ReadonlyMap<string, string>,
): Promise<void> {
  const folderId = doc.fileinfo?.[0]?.library_id ?? null;
  await coll.deleteOne({ _id: doc._id });
  await cleanRemovedLocationsCache(libs, doc.fileinfo ?? []);
  // Tombstone the Meilisearch document. A reaped row was never soft-deleted,
  // so without this the search index keeps surfacing an asset whose Mongo row
  // and on-disk file are both gone until the next full backfill. Best-effort.
  if (doc.maple_id) {
    try {
      await meilisearchClient().tombstone(doc.maple_id);
    } catch {
      /* best-effort — Mongo is canonical, search self-heals on rebuild */
    }
  }
  await recordAndPublishAssetChange({
    kind: "delete",
    asset_id: doc._id,
    folder_id: folderId,
    abs_path: null,
  });
}

export interface MissingReaperHandle {
  stop: () => void;
  /** Resolves once the persisted pause state has been read on boot. Tests await
   * this so they observe the adopted state; production ignores it. */
  ready: Promise<void>;
}

export interface StartMissingReaperOptions {
  intervalMs?: number;
  batchSize?: number;
}

/**
 * Start the reaper's interval loop and register it with the stage registry.
 *
 * Controlled exactly like every other worker: paused state persists in
 * `worker_config.paused` via pause/resume, so it RUNS by default and a pause
 * sticks across restarts. The returned handle's `stop()` cancels the loop and
 * unregisters; `ready` resolves once the persisted state has been adopted.
 */
export function startMissingReaper(
  opts: StartMissingReaperOptions = {},
): MissingReaperHandle {
  const intervalMs = opts.intervalMs ?? DEFAULT_INTERVAL_MS;
  const batchSize = opts.batchSize ?? DEFAULT_BATCH;

  // Paused only until the persisted control state is read — a config-store blip
  // on boot must not run a destructive sweep against an operator's prior pause.
  let paused = true;
  let running = false;
  let stopped = false;
  const throughput = new ThroughputWindow();

  // Persisted pause/resume, the same surface every other worker uses.
  let repoPromise: Promise<WorkerConfigRepo> | null = null;
  const getRepo = (): Promise<WorkerConfigRepo> => {
    if (!repoPromise) {
      repoPromise = (async () => {
        const { getDb } = await import("../db/client.ts");
        const db = await getDb();
        return new WorkerConfigRepo(
          db.collection<WorkerConfigDoc>("worker_config"),
        );
      })();
    }
    return repoPromise;
  };
  const loadPaused = async (): Promise<void> => {
    try {
      const cfg = await (await getRepo()).load(MISSING_REAPER_NAME);
      paused = cfg?.paused ?? false; // default running on first boot
    } catch (err) {
      log.warn(
        { err: err instanceof Error ? err.message : err },
        "missing-reaper: could not load persisted pause state — staying paused",
      );
    }
  };
  const persistPaused = async (value: boolean): Promise<void> => {
    try {
      const r = await getRepo();
      await r.patch(MISSING_REAPER_NAME, { paused: value });
    } catch {
      /* best-effort — in-memory state already applied; next boot re-reads */
    }
  };

  stageRegistry.register(MISSING_REAPER_NAME, {
    targetVersion: 1,
    // Not a claim stage — no upstream dependencies. The /status ready/blocked
    // split (and its buildClaimQuery) is gated to real claim stages anyway.
    dependsOn: [],
    getInFlight: () => (running ? 1 : 0),
    getThroughput: () => throughput.countInWindow(),
    getPaused: () => paused,
    reloadConfig: async () => {
      await loadPaused();
    },
    pause: async () => {
      paused = true;
      await persistPaused(true);
      log.info("missing-reaper paused");
    },
    resume: async () => {
      paused = false;
      await persistPaused(false);
      log.warn(
        "missing-reaper RESUMED — aged-out missing rows are now eligible for hard delete",
      );
    },
  });

  // Adopt the persisted control state shortly after boot.
  const ready = loadPaused();

  // Throttled cross-process pause poller (2s interval). See paused-poller.ts.
  const pollPaused = makePausedPoller(MISSING_REAPER_NAME, paused);

  const tick = async (): Promise<void> => {
    // Runs even when paused — recovery/prune (re-found files) must keep working;
    // only the hard-delete is gated by `allowDelete: !paused` below.
    if (stopped || running) return;
    running = true;
    try {
      paused = await pollPaused();
      const pruneWindowHours = await loadPruneWindowHours();
      const deleteBeforeIso = new Date(
        Date.now() - pruneWindowHours * 3_600_000,
      ).toISOString();
      const summary = await runMissingReaperOnce({
        batchSize,
        deleteBeforeIso,
        allowDelete: !paused,
      });
      for (let i = 0; i < summary.reaped; i++) throughput.record(new Date());
      stageRegistry.clearError(MISSING_REAPER_NAME);
    } catch (err) {
      stageRegistry.recordError(
        MISSING_REAPER_NAME,
        err instanceof Error ? err.message : String(err),
      );
      log.error({ err }, "missing-reaper pass crashed");
    } finally {
      running = false;
    }
  };

  const timer = setInterval(() => {
    void tick();
  }, intervalMs);

  log.info({ intervalMs }, "missing-reaper started");

  return {
    stop: () => {
      stopped = true;
      clearInterval(timer);
      stageRegistry.unregister(MISSING_REAPER_NAME);
    },
    ready,
  };
}
