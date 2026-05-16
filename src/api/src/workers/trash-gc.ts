/**
 * Trash garbage collector — purges trashed assets older than the
 * retention window. Per asset where `deleted_at < now - retentionDays`:
 *   1. Unlink the file at `abs_path` (already in .maple/trash/...).
 *   2. Unlink every paired sidecar.
 *   3. Delete the asset doc from Mongo.
 *
 * Idempotent. Best-effort on per-file failures: a failed unlink is logged
 * and the asset doc is still deleted so subsequent runs don't keep
 * retrying the same broken row.
 *
 * NOT a stage controller — this is a library-wide, interval-fired job.
 * Started from `src/api/src/index.ts` via setInterval.
 */

import { unlink } from "node:fs/promises";
import { assetsCollection } from "../db/client.ts";
import { listPairedSidecars } from "../fs/xmp.ts";
import { child as childLogger } from "../log.ts";

const log = childLogger("trash-gc");
const DAY_MS = 86_400_000;
const DEFAULT_RETENTION_DAYS = 30;
const DEFAULT_INTERVAL_MS = DAY_MS;

export interface TrashGcOptions {
  retentionDays?: number;
}

export interface TrashGcSummary {
  scanned: number;
  purged: number;
  errors: number;
}

/** One pass. Exported for tests + callable from setInterval. */
export async function runTrashGcOnce(opts: TrashGcOptions = {}): Promise<TrashGcSummary> {
  const retentionDays = opts.retentionDays ?? DEFAULT_RETENTION_DAYS;
  const cutoffIso = new Date(Date.now() - retentionDays * DAY_MS).toISOString();
  const coll = await assetsCollection();
  const cursor = coll.find(
    { deleted_at: { $lt: cutoffIso, $ne: null } },
    { projection: { _id: 1, abs_path: 1 } },
  );
  let scanned = 0;
  let purged = 0;
  let errors = 0;
  for await (const doc of cursor) {
    scanned++;
    const absPath = doc.abs_path;
    try { await unlink(absPath); } catch (err) {
      // ENOENT is fine — file might already be gone.
      const code = (err as { code?: string } | null)?.code;
      if (code !== "ENOENT") {
        errors++;
        log.warn({ absPath, err: err instanceof Error ? err.message : err }, "purge unlink failed");
      }
    }
    const sidecars = await listPairedSidecars(absPath);
    for (const sidecar of sidecars) {
      try { await unlink(sidecar); } catch (err) {
        const code = (err as { code?: string } | null)?.code;
        if (code !== "ENOENT") {
          errors++;
          log.warn({ sidecar, err: err instanceof Error ? err.message : err }, "purge sidecar unlink failed");
        }
      }
    }
    await coll.deleteOne({ _id: doc._id });
    purged++;
  }
  if (scanned > 0) log.info({ scanned, purged, errors }, "trash-gc pass complete");
  return { scanned, purged, errors };
}

export interface TrashGcHandle { stop: () => void }

/** Start a background loop. Returns a handle whose `stop()` cancels it. */
export function startTrashGc(opts: TrashGcOptions & { intervalMs?: number } = {}): TrashGcHandle {
  const intervalMs = opts.intervalMs ?? DEFAULT_INTERVAL_MS;
  let stopped = false;
  const tick = async () => {
    if (stopped) return;
    try { await runTrashGcOnce(opts); }
    catch (err) {
      log.error({ err: err instanceof Error ? err.message : err }, "trash-gc pass crashed");
    }
  };
  const timer = setInterval(() => { void tick(); }, intervalMs);
  // Fire once on startup so a freshly-booted server doesn't wait 24h
  // before its first sweep. Errors are swallowed by tick() so a stray
  // failure doesn't crash boot.
  void tick();
  return {
    stop: () => {
      stopped = true;
      clearInterval(timer);
    },
  };
}
