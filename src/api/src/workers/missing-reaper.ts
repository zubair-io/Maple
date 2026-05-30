/**
 * Missing-file reaper — hard-deletes asset rows whose on-disk original has
 * vanished from disk underneath the index.
 *
 * Two-stage, deliberately conservative, operator-gated lifecycle:
 *   1. TAG (automatic). Any file-touching stage (exif / thumb / preview)
 *      stamps `missing_since` — an ISO timestamp — the first time it hits
 *      ENOENT on the original (see `withMissingTag` in
 *      `src/indexer/images.repo.ts`). Tagging is the ONLY automatic step;
 *      nothing is ever deleted automatically.
 *   2. REAP (operator-gated). This worker, once RESUMED by an operator,
 *      periodically scans for tagged rows, re-verifies them on disk, and
 *      hard-deletes the record (emitting a `delete` change event) only when
 *      EVERY live location is genuinely gone.
 *
 * Three safety properties, all load-bearing:
 *
 *   - Always starts PAUSED. Boot never auto-resumes it, regardless of any
 *     stored state — deleting DB rows is destructive, so a human flips it on
 *     from /settings/workers each server start.
 *
 *   - Boot-time start gate. `startedAt` is captured when the loop boots; only
 *     rows whose `missing_since` PREDATES `startedAt` are eligible. A row can
 *     never be reaped in the same process lifetime it was tagged, so a
 *     mass-unmount that happens after boot is never swept by the running
 *     reaper — those fresh tags wait for the next restart's later
 *     `startedAt`. This is the cool-down crux: it bounds how much a single
 *     bad event can delete.
 *
 *   - Mount guard. If an asset's library root is unregistered, or its mount
 *     point isn't present on disk, or a location can't be stat'd, the asset
 *     is SKIPPED (never deleted). A whole offline share must not be mistaken
 *     for a pile of deleted files.
 *
 * Per-row re-verification: every LIVE `fileinfo` entry is re-stat'd. If any
 * still exists the file came back → `missing_since` is cleared (recovered).
 * If a library is offline / unregistered / unreadable → skip. Only when all
 * live locations confirm ENOENT does the row get hard-deleted.
 *
 * Registered into the in-process `stageRegistry` so the existing
 * `/api/workers/missing-reaper/{status,pause,resume}` surface controls it,
 * the same as every pipeline stage. It is NOT a version-claim stage, so it
 * runs its own interval loop (mirrors `trash-gc`) rather than `runStage()`.
 * Started from `src/index.ts`.
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { ObjectId } from 'mongodb';
import { assetsCollection } from '../db/client.ts';
import { assetPrimaryFileInfo } from '../indexer/images.repo.ts';
import { loadLibraryRoots } from '../indexer/libraries.cache.ts';
import { recordAndPublishAssetChange } from '../db/changes.repo.ts';
import type { FileInfo } from '../db/schema.ts';
import { child as childLogger } from '../log.ts';
import { stageRegistry } from './registry.ts';
import { ThroughputWindow } from './run-stage.ts';

const log = childLogger('missing-reaper');

/** Registry / route key. Matches `/api/workers/missing-reaper/...`. */
export const MISSING_REAPER_NAME = 'missing-reaper';

const DEFAULT_INTERVAL_MS = 60_000;
const DEFAULT_BATCH = 200;

export interface MissingReaperSummary {
  /** Tagged candidates examined this pass. */
  scanned: number;
  /** Rows hard-deleted (all live locations confirmed gone). */
  reaped: number;
  /** Rows whose file turned out to still be present → tag cleared. */
  recovered: number;
  /** Rows skipped because a library was offline / unregistered / unreadable. */
  skippedMountOffline: number;
  /** Rows that raised an unexpected error during the pass. */
  errors: number;
}

/** Live (non-tombstoned) on-disk locations for an asset. */
function liveFileInfos(fileinfo: FileInfo[] | undefined): FileInfo[] {
  return (fileinfo ?? []).filter((f) => !f.deleted_at);
}

type StatKind = 'present' | 'absent' | 'error';

/** Classify a path: present, absent (ENOENT), or an error we must not treat
 * as "deleted" (EACCES, EIO, an unmounted share that errors rather than
 * ENOENTs, …). Errors are conservative — the caller skips, never deletes. */
async function statKind(p: string): Promise<StatKind> {
  try {
    await fs.stat(p);
    return 'present';
  } catch (err) {
    return (err as { code?: string } | null)?.code === 'ENOENT' ? 'absent' : 'error';
  }
}

export interface RunMissingReaperOptions {
  /** Max tagged rows to examine in one pass. */
  batchSize?: number;
  /** Only rows whose `missing_since` is strictly before this ISO timestamp
   * are eligible (the boot-time start gate). */
  startedAtIso: string;
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

  // Per-pass cache of "does this library root resolve AND exist on disk".
  // A library missing from the map (unregistered folder) or whose root path
  // isn't a present directory counts as offline → its assets are skipped.
  const rootStatus = new Map<string, 'present' | 'offline'>();
  const checkRoot = async (libIdHex: string): Promise<'present' | 'offline'> => {
    const cached = rootStatus.get(libIdHex);
    if (cached) return cached;
    const root = libs.get(libIdHex);
    let status: 'present' | 'offline';
    if (!root) {
      status = 'offline';
    } else {
      status = (await statKind(root)) === 'present' ? 'present' : 'offline';
    }
    rootStatus.set(libIdHex, status);
    return status;
  };

  const summary: MissingReaperSummary = {
    scanned: 0,
    reaped: 0,
    recovered: 0,
    skippedMountOffline: 0,
    errors: 0,
  };

  // `$type: "string"` lets the planner use the `missing_since_1` partial
  // index instead of a COLLSCAN — same pattern as trash-gc's deleted_at query.
  const candidates = await coll
    .find(
      { missing_since: { $type: 'string', $lt: opts.startedAtIso, $ne: null } },
      { projection: { _id: 1, fileinfo: 1 } },
    )
    .limit(batchSize)
    .toArray();

  for (const doc of candidates) {
    summary.scanned++;
    try {
      const lives = liveFileInfos(doc.fileinfo);
      let cannotVerify = false;
      let stillPresent = false;

      for (const fi of lives) {
        const libIdHex = fi.library_id.toHexString();
        if ((await checkRoot(libIdHex)) === 'offline') {
          cannotVerify = true;
          break;
        }
        const root = libs.get(libIdHex)!;
        const segments = fi.path === '' ? [] : fi.path.split('/');
        const abs = path.join(root, ...segments, fi.filename);
        const kind = await statKind(abs);
        if (kind === 'present') {
          stillPresent = true;
          break;
        }
        if (kind === 'error') {
          // Couldn't confirm the file is gone — be safe and skip the row.
          cannotVerify = true;
          break;
        }
      }

      if (cannotVerify) {
        summary.skippedMountOffline++;
        continue;
      }
      if (stillPresent) {
        await coll.updateOne({ _id: doc._id }, { $set: { missing_since: null } });
        summary.recovered++;
        continue;
      }

      // Every live location confirmed ENOENT (or the row had none left) —
      // hard-delete and publish a delete event for FP / SSE consumers.
      const primary = assetPrimaryFileInfo(doc);
      await coll.deleteOne({ _id: doc._id });
      summary.reaped++;
      await recordAndPublishAssetChange({
        kind: 'delete',
        asset_id: doc._id as ObjectId,
        folder_id: primary?.library_id ?? null,
        abs_path: null,
      });
    } catch (err) {
      summary.errors++;
      log.warn(
        { _id: String(doc._id), err: err instanceof Error ? err.message : err },
        'missing-reaper: row failed',
      );
    }
  }

  if (summary.scanned > 0) log.info(summary, 'missing-reaper pass complete');
  return summary;
}

export interface MissingReaperHandle {
  stop: () => void;
}

export interface StartMissingReaperOptions {
  intervalMs?: number;
  batchSize?: number;
  /** Test seam — override the boot start time. Production omits it so the
   * gate is anchored to actual process boot. */
  startedAtIso?: string;
}

/**
 * Start the reaper's interval loop and register it with the stage registry.
 *
 * ALWAYS starts paused. The returned handle's `stop()` cancels the loop and
 * unregisters from the registry. The first tick is NOT fired eagerly (it would
 * be a no-op while paused anyway) — the operator resumes it deliberately.
 */
export function startMissingReaper(opts: StartMissingReaperOptions = {}): MissingReaperHandle {
  const intervalMs = opts.intervalMs ?? DEFAULT_INTERVAL_MS;
  const batchSize = opts.batchSize ?? DEFAULT_BATCH;
  const startedAtIso = opts.startedAtIso ?? new Date().toISOString();

  // Always paused on boot — destructive + operator-gated. Never read a stored
  // value here: a deliberate human action must re-arm it every server start.
  let paused = true;
  let running = false;
  let stopped = false;
  const throughput = new ThroughputWindow();

  stageRegistry.register(MISSING_REAPER_NAME, {
    targetVersion: 1,
    getInFlight: () => (running ? 1 : 0),
    getThroughput: () => throughput.countInWindow(),
    getPaused: () => paused,
    reloadConfig: async () => {
      /* no tunable config persisted — interval/batch are process constants */
    },
    pause: async () => {
      paused = true;
      log.info('missing-reaper paused');
    },
    resume: async () => {
      paused = false;
      log.warn(
        { startedAtIso },
        'missing-reaper RESUMED — rows tagged missing before boot are now eligible for hard delete',
      );
    },
  });

  const tick = async (): Promise<void> => {
    if (stopped || paused || running) return;
    running = true;
    try {
      const summary = await runMissingReaperOnce({ batchSize, startedAtIso });
      for (let i = 0; i < summary.reaped; i++) throughput.record(new Date());
      stageRegistry.clearError(MISSING_REAPER_NAME);
    } catch (err) {
      stageRegistry.recordError(
        MISSING_REAPER_NAME,
        err instanceof Error ? err.message : String(err),
      );
      log.error({ err }, 'missing-reaper pass crashed');
    } finally {
      running = false;
    }
  };

  const timer = setInterval(() => {
    void tick();
  }, intervalMs);

  log.info({ intervalMs, startedAtIso }, 'missing-reaper started (paused)');

  return {
    stop: () => {
      stopped = true;
      clearInterval(timer);
      stageRegistry.unregister(MISSING_REAPER_NAME);
    },
  };
}
