/**
 * Missing-file reaper — hard-deletes asset rows whose on-disk original has
 * vanished from disk underneath the index.
 *
 * Lifecycle:
 *   1. TAG (automatic). A file-touching stage (exif/thumb/preview) stamps
 *      `missing_since` the first time it ENOENTs on the original (see
 *      `tagMissingSince` in `./tag-missing.ts`) — the only automatic step.
 *   2. REAP. This worker scans tagged rows each tick, re-verifies on disk, and
 *      either recovers/prunes them or — once aged past the prune window —
 *      hard-deletes the record (emitting a `delete` change event).
 *
 * Safety properties, all load-bearing:
 *
 *   - Controlled like every other worker. Its paused state lives in
 *     `worker_config.paused`; pause/resume persist it, so a pause STICKS across
 *     restarts. But "paused" suspends ONLY the irreversible hard-delete —
 *     recovery/prune (re-found files, stale-entry cleanup, tag clearing) keeps
 *     running every tick, so a moved/re-copied file reconciles even while
 *     paused. On boot it stays paused only until the stored state is read, so a
 *     config-store blip can't run a sweep against an operator's prior pause.
 *
 *   - Age window (cool-down), not a boot gate. An all-gone row is hard-deleted
 *     only once it has been missing for at least `prune_window_hours` (default
 *     12h, in `app_settings`, env `MAPLE_REAPER_PRUNE_HOURS`). This bounds how
 *     fast a transient mass-unmount can turn into deletions and doesn't depend
 *     on process restarts. Recovery is never age-gated.
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
import { WorkerConfigRepo, type WorkerConfigDoc } from './worker-config.repo.ts';
import { loadPruneWindowHours } from './missing-reaper-config.repo.ts';
import { makePausedPoller } from './paused-poller.ts';

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
  /** All-gone rows left because they haven't been missing long enough yet
   * (`missing_since` newer than the prune window). */
  skippedCooldown: number;
  /** All-gone, aged-out rows left because deletes are paused (recovery still
   * runs while paused — only the irreversible hard-delete is suspended). */
  skippedPaused: number;
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

type NearMatch =
  /** A case/NFC near-match of the basename exists in the parent dir — the file
   * is on disk under a different name (stored-path bug, NOT a deletion). */
  | 'match'
  /** Parent listed cleanly with no near-match — genuinely absent. */
  | 'clear'
  /** Parent couldn't be listed (EACCES/EIO/…) — we can't prove absence, so the
   * caller must NOT delete this pass. */
  | 'unreadable';

/** Classify whether `absPath` (already known ENOENT) has a near-match sibling.
 * Used only to gate the irreversible hard-delete. Only an ENOENT parent counts
 * as genuinely gone; any other readdir error returns `unreadable` so a row is
 * never deleted on the strength of a directory we couldn't read. */
async function nearMatchOnDisk(absPath: string): Promise<NearMatch> {
  const dir = path.dirname(absPath);
  const target = path.basename(absPath).normalize('NFC').toLowerCase();
  let entries: string[];
  try {
    entries = await fs.readdir(dir);
  } catch (err) {
    return (err as { code?: string } | null)?.code === 'ENOENT' ? 'clear' : 'unreadable';
  }
  return entries.some((e) => e.normalize('NFC').toLowerCase() === target) ? 'match' : 'clear';
}

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

  // Every tagged row is examined each pass (no boot gate) — recovery is prompt.
  // The age window + pause only gate the irreversible hard-delete below.
  // `$type: "string"` lets the planner use the `missing_since_1` partial index
  // instead of a COLLSCAN — same pattern as trash-gc's deleted_at query.
  const candidates = await coll
    .find(
      { missing_since: { $type: 'string', $ne: null } },
      {
        projection: {
          _id: 1,
          fileinfo: 1,
          maple_id: 1,
          missing_since: 1,
          // Dead flags for the original-file stages — so recovery can re-arm
          // ones that dead-lettered against the vanished path (drains the
          // legacy backlog from before tag-only suppression).
          'stages.exif.dead': 1,
          'stages.thumb.dead': 1,
          'stages.preview.dead': 1,
        },
      },
    )
    // Oldest-missing first. With a backlog larger than `batchSize` the scan
    // order is load-bearing: an unsorted limit could starve aged-out /
    // recoverable rows behind a wall of still-in-cooldown ones. Sorting on the
    // partial-indexed field keeps filter+sort index-backed and prioritises the
    // longest-missing for both recovery and deletion.
    .sort({ missing_since: 1 })
    .limit(batchSize)
    .toArray();

  // Defer hard-deletes: classify all candidates first, then gate on the circuit breaker.
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

      // No live location survives. Before the irreversible delete, list each
      // gone entry's parent: a near-match means the file is on disk under a
      // different name (stored-path bug → skip for inspection); an unreadable
      // parent means we can't prove absence (→ skip, never delete).
      let veto: 'name-mismatch' | 'unreadable' | null = null;
      for (const fi of absent) {
        const root = libs.get(fi.library_id.toHexString())!;
        const segments = fi.path === '' ? [] : fi.path.split('/');
        const verdict = await nearMatchOnDisk(path.join(root, ...segments, fi.filename));
        if (verdict === 'match') {
          veto = 'name-mismatch';
          break;
        }
        if (verdict === 'unreadable') {
          veto = 'unreadable';
          break;
        }
      }
      if (veto === 'name-mismatch') {
        summary.skippedNameMismatch++;
        log.warn(
          { _id: String(doc._id) },
          'missing-reaper: stored path ENOENT but a near-match exists on disk — skipped, not deleted',
        );
        continue;
      }
      if (veto === 'unreadable') {
        // Couldn't list a gone entry's directory — treat like an offline mount:
        // skip rather than delete on unproven absence.
        summary.skippedMountOffline++;
        log.warn(
          { _id: String(doc._id) },
          'missing-reaper: gone entry parent dir unreadable — skipped, not deleted',
        );
        continue;
      }

      // Genuinely all-gone. Gate the irreversible delete:
      //  - age window: must have been missing for >= the prune window.
      //  - pause: deletes suspended (recovery already ran above regardless).
      const tag = (doc as { missing_since?: string }).missing_since ?? '';
      if (!(tag < opts.deleteBeforeIso)) {
        summary.skippedCooldown++;
        continue;
      }
      if (!allowDelete) {
        summary.skippedPaused++;
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

/** A surviving row: $pull the gone entries, clear the tag, and re-arm any
 * original-file stage that dead-lettered against the vanished path so it
 * reprocesses the corrected primary. Tag-only-parked stages (the new path) were
 * never marked dead, so clearing `missing_since` is enough for them — they
 * re-enter the claim query on their own. The re-arm is for the legacy `dead`
 * backlog from before tag-only suppression. */
async function recoverAndPrune(
  coll: Awaited<ReturnType<typeof assetsCollection>>,
  doc: {
    _id: ObjectId;
    fileinfo?: FileInfo[];
    stages?: Record<string, { dead?: boolean }>;
  },
  absent: FileInfo[],
  summary: MissingReaperSummary,
): Promise<void> {
  const set: Record<string, unknown> = { missing_since: null };
  for (const name of ORIGINAL_FILE_STAGES) {
    if (doc.stages?.[name]?.dead === true) {
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
        $or: absent.map((a) => ({
          library_id: a.library_id,
          path: a.path,
          filename: a.filename,
        })),
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
export function startMissingReaper(opts: StartMissingReaperOptions = {}): MissingReaperHandle {
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
        const { getDb } = await import('../db/client.ts');
        const db = await getDb();
        return new WorkerConfigRepo(db.collection<WorkerConfigDoc>('worker_config'));
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
        'missing-reaper: could not load persisted pause state — staying paused',
      );
    }
  };
  const persistPaused = (value: boolean): void => {
    void getRepo()
      .then((r) => r.patch(MISSING_REAPER_NAME, { paused: value }))
      .catch(() => {
        /* best-effort — in-memory state already applied; next boot re-reads */
      });
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
      persistPaused(true);
      log.info('missing-reaper paused');
    },
    resume: async () => {
      paused = false;
      persistPaused(false);
      log.warn('missing-reaper RESUMED — aged-out missing rows are now eligible for hard delete');
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
      const deleteBeforeIso = new Date(Date.now() - pruneWindowHours * 3_600_000).toISOString();
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
      log.error({ err }, 'missing-reaper pass crashed');
    } finally {
      running = false;
    }
  };

  const timer = setInterval(() => {
    void tick();
  }, intervalMs);

  log.info({ intervalMs }, 'missing-reaper started');

  return {
    stop: () => {
      stopped = true;
      clearInterval(timer);
      stageRegistry.unregister(MISSING_REAPER_NAME);
    },
    ready,
  };
}
