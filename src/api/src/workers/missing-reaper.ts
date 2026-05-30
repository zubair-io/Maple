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
 * Safety properties, all load-bearing:
 *
 *   - Paused by default. Boot never auto-resumes from stored state. Auto-run is
 *     an explicit deployment opt-in (`MAPLE_REAPER_AUTORUN` / `opts.autoRun`);
 *     a plain deploy stays operator-gated and a human flips it on from
 *     /settings/workers.
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
 *   - Name-mismatch veto. Before the irreversible hard-delete, each gone
 *     location's parent dir is listed; a case/Unicode near-match means the file
 *     is on disk under a different name (a stored-path bug), so the row is
 *     SKIPPED for inspection rather than deleted.
 *
 *   - Circuit breaker. A pass that would hard-delete a large fraction of what
 *     it scanned aborts WITHOUT deleting — a systemic mis-detection guard.
 *
 * Per-row re-verification: every LIVE `fileinfo` entry is re-stat'd.
 *   - Any location still present → the row SURVIVES: its gone sibling entries
 *     are pruned ($pull), `missing_since` is cleared, and — only if the pruned
 *     set included the primary location — the original-file stages (exif /
 *     thumb / preview) are re-queued so they reprocess the corrected primary.
 *   - A library offline / unregistered / unreadable → skip.
 *   - Only when EVERY live location confirms ENOENT (and no near-match veto)
 *     does the row get hard-deleted.
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
import { meilisearchClient } from '../enrichment/meilisearch-client.ts';
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
  /** Rows that kept at least one live location → tag cleared (and any gone
   * sibling entries pruned). */
  recovered: number;
  /** fileinfo entries pruned ($pull) across all recovered rows this pass. */
  prunedEntries: number;
  /** Rows skipped because a library was offline / unregistered / unreadable. */
  skippedMountOffline: number;
  /** Rows whose only location stat'd ENOENT but a case/Unicode near-match
   * exists on disk — left untouched for human inspection, never deleted. */
  skippedNameMismatch: number;
  /** True when the circuit breaker tripped and the pass aborted without
   * executing any hard-deletes (a systemic mis-detection guard). */
  aborted: boolean;
  /** Rows that raised an unexpected error during the pass. */
  errors: number;
}

/**
 * Stages that read the ORIGINAL file (StageConfig.tagsMissingOnEnoent). When
 * the reaper prunes the entry that was serving as the primary location, these
 * are re-queued (version 0, dead cleared) so they reprocess against the
 * corrected primary instead of staying dead/skipped on the vanished path.
 * Kept in sync with the tagsMissingOnEnoent stages.
 */
const ORIGINAL_FILE_STAGES = ['exif', 'thumb', 'preview'] as const;

/** Circuit breaker: abort a pass without deleting if it would hard-delete more
 * than BREAKER_MIN rows AND more than BREAKER_FRACTION of those scanned. Bounds
 * the blast radius of a systemic mis-detection (e.g. a root that stats present
 * but whose children all ENOENT). */
const BREAKER_MIN = 25;
const BREAKER_FRACTION = 0.5;

/** Live (non-tombstoned) on-disk locations for an asset. */
function liveFileInfos(fileinfo: FileInfo[] | undefined): FileInfo[] {
  return (fileinfo ?? []).filter((f) => !f.deleted_at);
}

function sameEntry(a: FileInfo, b: FileInfo): boolean {
  return a.library_id.equals(b.library_id) && a.path === b.path && a.filename === b.filename;
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

/** True when `absPath` is itself ENOENT but a case-insensitive / NFC near-match
 * of its basename exists in the parent directory — i.e. the file is actually on
 * disk under a slightly different name (a stored-path bug, NOT a deletion). Used
 * only to veto the irreversible hard-delete; the row is left for inspection. */
async function hasNearMatchOnDisk(absPath: string): Promise<boolean> {
  const dir = path.dirname(absPath);
  const target = path.basename(absPath).normalize('NFC').toLowerCase();
  let entries: string[];
  try {
    entries = await fs.readdir(dir);
  } catch {
    // Parent unreadable / gone → no near-match we can prove. Caller already
    // confirmed ENOENT, so genuinely absent.
    return false;
  }
  return entries.some((e) => e.normalize('NFC').toLowerCase() === target);
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
    prunedEntries: 0,
    skippedMountOffline: 0,
    skippedNameMismatch: 0,
    aborted: false,
    errors: 0,
  };

  // `$type: "string"` lets the planner use the `missing_since_1` partial
  // index instead of a COLLSCAN — same pattern as trash-gc's deleted_at query.
  const candidates = await coll
    .find(
      { missing_since: { $type: 'string', $lt: opts.startedAtIso, $ne: null } },
      { projection: { _id: 1, fileinfo: 1, maple_id: 1 } },
    )
    .limit(batchSize)
    .toArray();

  // Hard-deletes are deferred: we classify every candidate first (executing the
  // safe prune/recover writes inline), then gate the irreversible deletes
  // behind the circuit breaker before running them.
  const toDelete: typeof candidates = [];

  for (const doc of candidates) {
    summary.scanned++;
    try {
      const lives = liveFileInfos(doc.fileinfo);
      const present: FileInfo[] = [];
      const absent: FileInfo[] = [];
      let cannotVerify = false;

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
        if (kind === 'present') present.push(fi);
        else if (kind === 'absent') absent.push(fi);
        else {
          // Couldn't confirm the file is gone (EACCES/EIO/…) — skip the row.
          cannotVerify = true;
          break;
        }
      }

      if (cannotVerify) {
        summary.skippedMountOffline++;
        continue;
      }

      if (present.length > 0) {
        // At least one copy survives: prune the gone entries, clear the tag,
        // and (only if the entry we pruned was serving as the primary) re-arm
        // the original-file stages so they reprocess against the new primary.
        await recoverAndPrune(coll, doc, absent, summary);
        continue;
      }

      // No live location survives. Veto the irreversible delete if any entry is
      // really on disk under a near-match name (a stored-path bug, not a
      // deletion) — leave it tagged for a human to inspect.
      let nameMismatch = false;
      for (const fi of absent) {
        const root = libs.get(fi.library_id.toHexString())!;
        const segments = fi.path === '' ? [] : fi.path.split('/');
        if (await hasNearMatchOnDisk(path.join(root, ...segments, fi.filename))) {
          nameMismatch = true;
          break;
        }
      }
      if (nameMismatch) {
        summary.skippedNameMismatch++;
        log.warn(
          { _id: String(doc._id) },
          'missing-reaper: stored path ENOENT but a near-match exists on disk — skipped, not deleted',
        );
        continue;
      }
      toDelete.push(doc);
    } catch (err) {
      summary.errors++;
      log.warn(
        { _id: String(doc._id), err: err instanceof Error ? err.message : err },
        'missing-reaper: row failed',
      );
    }
  }

  // Circuit breaker: a pass that wants to hard-delete a large fraction of what
  // it scanned is far more likely a systemic mis-detection than that many real
  // deletions. Abort without deleting and surface it loudly.
  if (toDelete.length > BREAKER_MIN && toDelete.length > summary.scanned * BREAKER_FRACTION) {
    summary.aborted = true;
    log.error(
      { wouldDelete: toDelete.length, scanned: summary.scanned },
      'missing-reaper: circuit breaker tripped — too many hard-deletes in one pass; aborting WITHOUT deleting',
    );
    return summary;
  }

  for (const doc of toDelete) {
    try {
      await hardDeleteRow(coll, doc);
      summary.reaped++;
    } catch (err) {
      summary.errors++;
      log.warn(
        { _id: String(doc._id), err: err instanceof Error ? err.message : err },
        'missing-reaper: hard-delete failed',
      );
    }
  }

  if (summary.scanned > 0) log.info(summary, 'missing-reaper pass complete');
  return summary;
}

/** A surviving row: $pull the gone entries, clear the tag, and re-arm the
 * original-file stages iff the pruned set included the primary location. */
async function recoverAndPrune(
  coll: Awaited<ReturnType<typeof assetsCollection>>,
  doc: { _id: ObjectId; fileinfo?: FileInfo[] },
  absent: FileInfo[],
  summary: MissingReaperSummary,
): Promise<void> {
  const set: Record<string, unknown> = { missing_since: null };
  const primary = assetPrimaryFileInfo(doc as never);
  const primaryPruned = primary != null && absent.some((a) => sameEntry(a, primary));
  if (primaryPruned) {
    for (const name of ORIGINAL_FILE_STAGES) {
      set[`stages.${name}.version`] = 0;
      set[`stages.${name}.attempts`] = 0;
      set[`stages.${name}.last_error`] = null;
      set[`stages.${name}.dead`] = false;
    }
  }
  const update: Record<string, unknown> = { $set: set };
  if (absent.length > 0) {
    update['$pull'] = {
      fileinfo: {
        $or: absent.map((a) => ({ library_id: a.library_id, path: a.path, filename: a.filename })),
      },
    };
  }
  await coll.updateOne({ _id: doc._id }, update as never);
  summary.recovered++;
  summary.prunedEntries += absent.length;
}

/** Hard-delete a row whose every live location is gone, tombstone its search
 * doc, and publish a delete event. */
async function hardDeleteRow(
  coll: Awaited<ReturnType<typeof assetsCollection>>,
  doc: { _id: ObjectId; fileinfo?: FileInfo[]; maple_id?: string },
): Promise<void> {
  const primary = assetPrimaryFileInfo(doc as never);
  await coll.deleteOne({ _id: doc._id });
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
    kind: 'delete',
    asset_id: doc._id,
    folder_id: primary?.library_id ?? null,
    abs_path: null,
  });
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
  /**
   * Opt into auto-run: the reaper boots RUNNING instead of paused. Defaults to
   * the `MAPLE_REAPER_AUTORUN` env flag (`1`/`true`). Safe-by-default stays the
   * code default (paused) so a plain deploy never auto-deletes; an operator
   * sets the env var once on a deployment they want self-cleaning. The
   * boot-gate, mount guard, name-mismatch veto and circuit breaker still apply.
   */
  autoRun?: boolean;
}

function autoRunFromEnv(): boolean {
  const v = process.env.MAPLE_REAPER_AUTORUN;
  return v === '1' || v === 'true';
}

/**
 * Start the reaper's interval loop and register it with the stage registry.
 *
 * Boots PAUSED by default (destructive work stays operator-gated); opt into
 * auto-run via `opts.autoRun` / `MAPLE_REAPER_AUTORUN`. The returned handle's
 * `stop()` cancels the loop and unregisters from the registry.
 */
export function startMissingReaper(opts: StartMissingReaperOptions = {}): MissingReaperHandle {
  const intervalMs = opts.intervalMs ?? DEFAULT_INTERVAL_MS;
  const batchSize = opts.batchSize ?? DEFAULT_BATCH;
  const startedAtIso = opts.startedAtIso ?? new Date().toISOString();
  const autoRun = opts.autoRun ?? autoRunFromEnv();

  // Paused unless auto-run is explicitly opted in. A stored value is never read
  // here: enabling auto-run is a deliberate deployment decision (env/opts), not
  // something a prior resume silently re-arms.
  let paused = !autoRun;
  let running = false;
  let stopped = false;
  const throughput = new ThroughputWindow();

  stageRegistry.register(MISSING_REAPER_NAME, {
    targetVersion: 1,
    // Not a claim stage — no upstream dependencies. The /status ready/blocked
    // split (and its buildClaimQuery) is gated to real claim stages anyway.
    dependsOn: [],
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

  log.info(
    { intervalMs, startedAtIso, paused },
    `missing-reaper started (${paused ? 'paused' : 'auto-run'})`,
  );

  return {
    stop: () => {
      stopped = true;
      clearInterval(timer);
      stageRegistry.unregister(MISSING_REAPER_NAME);
    },
  };
}
