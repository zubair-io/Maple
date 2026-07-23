/**
 * DeDuplicate worker — collapses an asset that has more than one live on-disk
 * location (`{$expr:{$gt:[{$size:'$fileinfo'},1]}}`, i.e. the byte-identical
 * same content found at several paths) down to a single kept copy. Every other
 * copy's original file (plus its paired XMP sidecars) is RELOCATED into
 * `<libraryRoot>/_duplicates/<original rel path>` and its entry is `$pull`ed
 * from `fileinfo`.
 *
 * Why this is safe under "originals are sacred": nothing is deleted. A duplicate
 * is *moved* into a reversible quarantine folder that the indexer skips (see
 * `DUPLICATES_DIR_NAME` in `fs/duplicates.ts`), and the worker boots PAUSED — it
 * does nothing until an operator resumes it from /settings/workers. A `dry_run`
 * config knob previews the moves without touching disk.
 *
 * `.keep` override: a `.keep` marker file in a folder PINS every copy living
 * there. When any on-disk copy of an asset is pinned, the worker keeps all
 * pinned copies (there may be more than one) and collapses only the un-pinned
 * ones; if every copy is pinned the asset is left untouched. The marker is
 * re-confirmed on disk each pass, so adding/removing a `.keep` takes effect
 * without re-indexing. The ranking below applies only to UN-pinned sets.
 *
 * Which copy is KEPT (the spec's ranking — see `selectKeeper` / `dedupe.helpers.ts`):
 *   1. prefer to move a copy under an `unsorted` folder
 *   2. then a `name.N.ext` numbered copy
 *   3. then an all-numeric directory path
 *   4. otherwise keep the LAST copy in the list
 *
 * Derived data:
 *   - XMP sidecars travel into `_duplicates` alongside the moved file (edits
 *     preserved & restorable) via `moveToDuplicates`.
 *   - Thumbs are `maple_id`-keyed and SHARED by every location, so a moved
 *     copy's thumb is cleaned only when the kept copy is NOT in that folder
 *     (else it would delete the kept copy's live cache). Previews are
 *     path-keyed (not `maple_id`-keyed — see `cachePathForAsset`'s doc), so
 *     they have no such sharing to preserve: a moved copy's previews are
 *     always cleaned at its old location regardless of where the keeper
 *     lives. When the cache anchor (`fileinfo[0]`) is one of the moved
 *     copies, the `thumb`/`preview` stages are re-armed so the kept copy
 *     regenerates them at its location (the serving route 404s on a cache miss;
 *     it does not lazily render).
 *
 * Not a per-asset version-claim stage: it runs its own interval loop (mirrors
 * `missing-reaper` / `migration`) and registers into the in-process
 * `stageRegistry` so the standard `/api/workers/deduplicate/{status,pause,resume}`
 * surface controls it. Started from `workers/maintenance.ts`.
 */

import * as path from 'node:path';
import type { ObjectId } from 'mongodb';
// Mirror-aware drop-in: cache unlinks replicate to the library's backup root(s).
// `readdir` / `stat` pass through to `node:fs/promises`.
import * as fs from '../fs/mirrored.ts';
import { assetsCollection } from '../db/client.ts';
import { loadLibraryRoots } from '../indexer/libraries.cache.ts';
import {
  isLiveFileInfo,
  assetPrimaryFileInfo,
  liveAwareDuplicatePredicate,
  updateLiveLocationCount,
} from '../indexer/images.repo.ts';
import { recordAndPublishAssetChange } from '../db/changes.repo.ts';
import type { AssetDoc, FileInfo } from '../db/schema.ts';
import { child as childLogger } from '../log.ts';
import { stageRegistry } from './registry.ts';
import { ThroughputWindow } from './run-stage.ts';
import { WorkerConfigRepo, type WorkerConfigDoc } from './worker-config.repo.ts';
import { makePausedPoller } from './paused-poller.ts';
import { libraryRootAvailable, statKind } from './missing-reaper.helpers.ts';
import { moveToDuplicates, directoryHasKeepFile } from '../fs/duplicates.ts';
import { cleanPreviewsCacheForLocation } from '../fs/preview-cache-cleanup.ts';
import { loadDeDuplicateConfig, DEFAULT_BATCH_SIZE } from './dedupe-config.repo.ts';
import {
  emptySummary,
  folderKey,
  reArmCacheStages,
  sameEntry,
  selectKeeper,
  type DeDuplicateSummary,
} from './dedupe.helpers.ts';

const log = childLogger('deduplicate');

/** Registry / route key. Matches `/api/workers/deduplicate/...`. */
export const DEDUPLICATE_NAME = 'deduplicate';

/** How long to sleep between completed work passes when not paused. */
const DEFAULT_INTERVAL_MS = 300_000;
/** How often to re-check the pause state when the worker is paused or idle.
 * Keeps the resume-to-first-pass latency under this value (≤5 s). */
const PAUSED_POLL_MS = 5_000;

/** Minimal projected shape the pass needs from each candidate row. */
interface DedupeCandidate {
  _id: ObjectId;
  fileinfo?: FileInfo[];
  maple_id?: string | null;
}

export interface RunDeDuplicateOptions {
  /** Max assets (rows with >1 fileinfo entry) to examine in one pass. */
  batchSize?: number;
  /** When true, log intended moves but mutate nothing on disk or in Mongo. */
  dryRun?: boolean;
}

/** One dedupe pass. Exported for tests + driven by the interval loop. */
export async function runDeDuplicateOnce(
  opts: RunDeDuplicateOptions = {},
): Promise<DeDuplicateSummary> {
  const batchSize = opts.batchSize ?? DEFAULT_BATCH_SIZE;
  const dryRun = opts.dryRun ?? false;
  const coll = await assetsCollection();

  let libs: ReadonlyMap<string, string>;
  try {
    libs = await loadLibraryRoots();
  } catch {
    libs = new Map();
  }

  const summary = emptySummary();

  // Live-aware gate: ≥2 live (non-tombstoned) fileinfo entries. Backed by the
  // `fileinfo_multi_location` partial index which narrows to multi-location rows,
  // then `$expr`+`$filter` counts only non-tombstoned entries per row (#1290).
  // Keeps in sync with the `/status` pending count (same predicate via
  // `liveAwareDuplicatePredicate`) so the badge reaches 0 from deduplicate alone
  // and wasted scan passes on sticky non-live rows are eliminated.
  //
  // NOTE: a duplicate set whose every on-disk copy is pinned by a `.keep` marker
  // stays a candidate here (and in the pending count) by design — `.keep` is
  // re-confirmed on disk per pass and the stored `fileinfo.keep` flag can go
  // stale, so there is no DB-side predicate that could safely exclude such rows
  // without risking permanently skipping a set whose marker was later removed.
  // Each pass processes them cheaply (stat the folders, `skippedAllKept`, return).
  const candidates = (await coll
    .find(liveAwareDuplicatePredicate() as never, {
      projection: { _id: 1, fileinfo: 1, maple_id: 1 },
    })
    .limit(batchSize)
    .toArray()) as DedupeCandidate[];

  for (const doc of candidates) {
    summary.scanned++;
    try {
      await processAsset(coll, doc, libs, dryRun, summary);
    } catch (err) {
      summary.errors++;
      log.warn(
        { _id: String(doc._id), err: err instanceof Error ? err.message : err },
        'deduplicate: asset failed',
      );
    }
  }

  if (summary.scanned === 0) {
    // INFO so operators get a clear "nothing left to deduplicate" signal once
    // the live-aware backlog drains to 0. Logged on every idle pass; at the
    // 5-minute interval this produces at most ~288 lines/day, which is
    // acceptable. Promoted from debug (#1290).
    log.info('deduplicate pass: no live candidates — backlog is empty');
  } else {
    if (summary.skippedOffline > 0) {
      log.warn(
        { skippedOffline: summary.skippedOffline },
        'deduplicate: assets skipped because library root could not be resolved — ' +
          'check that all libraries are mounted and their paths in the folders collection match the filesystem',
      );
    }
    log.info(summary, 'deduplicate pass complete');
  }
  return summary;
}

/** Collapse one asset's live duplicate locations down to the kept copy. */
async function processAsset(
  coll: Awaited<ReturnType<typeof assetsCollection>>,
  doc: DedupeCandidate,
  libs: ReadonlyMap<string, string>,
  dryRun: boolean,
  summary: DeDuplicateSummary,
): Promise<void> {
  const fileinfo = doc.fileinfo ?? [];
  const liveEntries = fileinfo.filter((e) => isLiveFileInfo(e));
  if (liveEntries.length < 2) return; // not a live duplicate set

  // Identify which copies ACTUALLY EXIST ON DISK before choosing anything to
  // move. A user moving a file makes discover record the new path before its
  // `removed` handler tombstones the old one, so for a window an asset has two
  // "live" entries but only ONE physical file. We must never pick a stale entry
  // as the keeper nor move the last real file — so we drive everything off the
  // on-disk set and require ≥2 real copies before moving anything.
  const onDisk: FileInfo[] = [];
  const absentEntries: FileInfo[] = [];
  for (const entry of liveEntries) {
    const root = libs.get(entry.library_id.toHexString());
    if (!root) {
      // Unresolvable library — can't verify the full picture; skip the asset.
      summary.skippedOffline++;
      return;
    }
    const segments = entry.path === '' ? [] : entry.path.split('/');
    const kind = await statKind(path.join(root, ...segments, entry.filename));
    if (kind === 'present') {
      onDisk.push(entry);
    } else if (kind === 'absent') {
      absentEntries.push(entry);
    } else {
      // 'error' (EACCES/EIO/offline mount) — a sibling we can't verify. Don't
      // act on a partial picture; skip the whole asset this pass.
      summary.skippedOffline++;
      return;
    }
  }

  // An absent entry is only trustworthy when its library ROOT is available
  // (#2171): an unmounted mount is a present-but-empty dir under which every
  // stat ENOENTs, which must read as "volume gone", not "files deleted". Any
  // unavailable root ⇒ skip the whole asset this pass, tagging nothing.
  if (absentEntries.length > 0) {
    const absentRoots = [
      ...new Set(absentEntries.map((e) => libs.get(e.library_id.toHexString())!)),
    ];
    for (const root of absentRoots) {
      if (!(await libraryRootAvailable(root))) {
        summary.skippedOffline++;
        return;
      }
    }
  }

  // Tag any absent entries so the missing-reaper can prune them after the
  // cooldown period. Only stamp entries that are NOT already tagged —
  // resetting `missing_since` on every pass would restart the reaper's
  // cooldown clock, preventing stale entries from ever aging out.
  if (absentEntries.length > 0 && !dryRun) {
    const now = new Date().toISOString();
    const tagged = await coll
      .updateOne(
        { _id: doc._id },
        {
          $set: {
            'fileinfo.$[e].missing_since': now,
            'fileinfo.$[e].missing_reason': 'dedupe-absent',
          },
        },
        {
          arrayFilters: [
            {
              $and: [
                {
                  $or: [{ 'e.missing_since': { $exists: false } }, { 'e.missing_since': null }],
                },
                {
                  $or: absentEntries.map((e) => ({
                    'e.library_id': e.library_id,
                    'e.path': e.path,
                    'e.filename': e.filename,
                  })),
                },
              ],
            },
          ],
        },
      )
      .then(() => true)
      .catch((err) => {
        log.warn(
          {
            _id: String(doc._id),
            err: err instanceof Error ? err.message : err,
          },
          'deduplicate: failed to tag absent entries',
        );
        return false;
      });
    if (tagged) {
      // Recompute live count after tagging absent entries missing_since.
      await updateLiveLocationCount(coll, doc._id).catch((err) => {
        log.warn(
          {
            _id: String(doc._id),
            err: err instanceof Error ? err.message : err,
          },
          'deduplicate: failed to recompute live_location_count after tagging',
        );
      });
    }
  }

  // Fewer than two copies on disk → not a real duplicate set right now (the
  // extra entries are stale and will be reconciled away by discover / the
  // missing-reaper). This return is THE guard against "no file left on disk":
  // we never move when only one physical copy exists.
  if (onDisk.length < 2) {
    if (absentEntries.length > 0) summary.skippedMissingFile++;
    return;
  }

  // `.keep` override: any on-disk copy whose folder holds a `.keep` marker is
  // PINNED and must survive. Re-confirmed on disk here (authoritative) rather
  // than trusting the stored `fileinfo.keep` flag, which can go stale if the
  // marker was added or removed after the file was first indexed. Folders are
  // cached so a folder shared by several copies is stat'd once.
  const keepByFolder = new Map<string, boolean>();
  const pinned: FileInfo[] = [];
  for (const entry of onDisk) {
    const key = folderKey(entry);
    let isKept = keepByFolder.get(key);
    if (isKept === undefined) {
      const root = libs.get(entry.library_id.toHexString())!;
      const segments = entry.path === '' ? [] : entry.path.split('/');
      isKept = await directoryHasKeepFile(path.join(root, ...segments));
      keepByFolder.set(key, isKept);
    }
    if (isKept) pinned.push(entry);
  }

  // When at least one copy is pinned, keep EVERY pinned copy and move the rest.
  // With no marker, fall back to the single-copy keeper ranking. Keepers are
  // guaranteed on-disk; the copies we move are the OTHER on-disk ones (all
  // confirmed present). They share this asset's `maple_id`, so they are
  // byte-identical — collapsing loses no content. Stale (absent) entries are
  // left for the reconciler.
  const keepers = pinned.length > 0 ? pinned : [selectKeeper(onDisk)];
  const keeperKeys = new Set(keepers.map(folderKey));
  const removeEntries = onDisk.filter((e) => !keepers.some((k) => sameEntry(e, k)));

  // Every on-disk copy is pinned by a `.keep` marker — nothing un-pinned to
  // collapse. Leave the asset exactly as it is (this is the whole point of the
  // marker: keep the duplicates).
  if (removeEntries.length === 0) {
    summary.skippedAllKept++;
    return;
  }

  // Representative surviving copy (earliest in fileinfo order) for change-publish
  // + cache-anchor math. With multiple keepers this is the one that becomes (or
  // stays nearest) the cache anchor.
  const primaryKeeper = keepers[0]!;
  const keeperRoot = libs.get(primaryKeeper.library_id.toHexString())!;
  const keeperSegments = primaryKeeper.path === '' ? [] : primaryKeeper.path.split('/');
  const keeperAbs = path.join(keeperRoot, ...keeperSegments, primaryKeeper.filename);

  // The current cache anchor = first live entry (which may be a stale/absent
  // one). If no surviving keeper shares its folder, re-arm the location-keyed
  // cache stages so a kept copy regenerates its thumb/preview at its folder.
  const oldPrimary = assetPrimaryFileInfo(doc as Pick<AssetDoc, 'fileinfo'>)!;
  const anchorMoves = !keeperKeys.has(folderKey(oldPrimary));

  const moved: FileInfo[] = [];
  for (const entry of removeEntries) {
    const root = libs.get(entry.library_id.toHexString())!;
    const segments = entry.path === '' ? [] : entry.path.split('/');
    const abs = path.join(root, ...segments, entry.filename);

    if (dryRun) {
      log.info({ _id: String(doc._id), from: abs }, 'deduplicate dry-run: would move duplicate');
      moved.push(entry);
      continue;
    }

    // `moveToDuplicates` returns an error (never throws) if the source vanished
    // in the small window since we stat'd it — counted and skipped, not fatal.
    const res = await moveToDuplicates(abs, root);
    if (res.kind === 'error') {
      summary.errors++;
      log.warn({ _id: String(doc._id), abs, err: res.error }, 'deduplicate: move failed');
      continue;
    }
    summary.movedFiles++;
    log.info(
      { _id: String(doc._id), from: abs, to: res.newAbsPath },
      'deduplicate: moved duplicate to _duplicates/',
    );

    // Previews are path-keyed, not shared across locations — always clean
    // the moved copy's previews at its old location. Thumbs ARE shared
    // (maple_id-keyed), so only clean those when no surviving keeper is in
    // this folder (else it would delete the kept copy's live thumb).
    await cleanPreviewsCacheForLocation(root!, entry).catch(() => {});
    if (doc.maple_id && !keeperKeys.has(folderKey(entry))) {
      await cleanThumbCache(path.dirname(abs), doc.maple_id);
    }
    moved.push(entry);
  }

  if (moved.length === 0) return; // nothing actually moved (all missing / errored)

  if (dryRun) {
    summary.dryRun++;
    return; // no Mongo mutation in dry-run
  }

  // Pull the moved entries from `fileinfo` one at a time.
  //
  // MongoDB does NOT support `$or` inside a `$pull` filter expression — it is
  // silently ignored and the update modifies 0 documents (the file gets moved
  // but the DB entry stays, so the asset keeps showing as a duplicate).
  // The correct approach for compound-key matches is one `$pull` per entry.
  //
  // The cache-stage re-arm (`$set`) is fused into the first pull so it lands
  // atomically with the first fileinfo removal. Subsequent pulls are pure
  // `$pull` calls (one round-trip each; typically only one or two entries).
  for (let i = 0; i < moved.length; i++) {
    const m = moved[i];
    const pullUpdate: Record<string, unknown> = {
      $pull: {
        fileinfo: {
          library_id: m.library_id,
          path: m.path,
          filename: m.filename,
        },
      },
    };
    if (i === 0 && anchorMoves) pullUpdate['$set'] = reArmCacheStages();
    await coll.updateOne({ _id: doc._id }, pullUpdate as never);
  }
  // Recompute live count after pulling moved entries from fileinfo.
  await updateLiveLocationCount(coll, doc._id);
  summary.deduped++;

  // Publish an update keyed by the surviving primary so clients + search refresh.
  await recordAndPublishAssetChange({
    kind: 'update',
    asset_id: doc._id,
    folder_id: primaryKeeper.library_id,
    abs_path: keeperAbs,
  });
}

/**
 * Delete the `maple_id`-keyed thumb in one folder's `.maple/thumbs` cache.
 * Called for a moved copy's folder ONLY when no surviving live entry shares
 * it, so the kept copy's thumb is never touched. Best-effort — derived data
 * regenerates. (Previews are handled separately by
 * `cleanPreviewsCacheForLocation` — they're path-keyed, not shared across
 * locations, so they're always cleaned regardless of where the keeper is.)
 */
async function cleanThumbCache(folderAbs: string, mapleId: string): Promise<void> {
  await fs.unlink(path.join(folderAbs, '.maple', 'thumbs', `${mapleId}.avif`)).catch(() => {});
  // Legacy JPEG thumb from the pre-v3 (JPEG) thumbnail pipeline — may not
  // exist for assets thumbnailed after the AVIF migration, hence best-effort.
  await fs.unlink(path.join(folderAbs, '.maple', 'thumbs', `${mapleId}.jpg`)).catch(() => {});
}

export interface DeDuplicateHandle {
  stop: () => void;
  /** Resolves once the persisted pause state has been read on boot. Tests await
   * this so they observe the adopted state; production ignores it. */
  ready: Promise<void>;
}

export interface StartDeDuplicateOptions {
  intervalMs?: number;
}

/**
 * Start the worker's interval loop and register it with the stage registry.
 *
 * Boots PAUSED. Unlike `missing-reaper`/`migration` (which default to running),
 * this worker relocates user originals, so its first-boot default is paused —
 * `loadPaused` adopts `worker_config.paused ?? true`. An operator resumes it via
 * `POST /api/workers/deduplicate/resume`. The persisted pause state then sticks
 * across restarts exactly like every other worker.
 */
export function startDeDuplicate(opts: StartDeDuplicateOptions = {}): DeDuplicateHandle {
  const intervalMs = opts.intervalMs ?? DEFAULT_INTERVAL_MS;

  // Paused until the persisted state is read AND paused-by-default on first boot.
  let paused = true;
  let running = false;
  let stopped = false;
  const throughput = new ThroughputWindow();

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
      const cfg = await (await getRepo()).load(DEDUPLICATE_NAME);
      paused = cfg?.paused ?? true; // default PAUSED on first boot (opt-in)
    } catch (err) {
      log.warn(
        { err: err instanceof Error ? err.message : err },
        'deduplicate: could not load persisted pause state — staying paused',
      );
    }
  };
  const persistPaused = async (value: boolean): Promise<void> => {
    try {
      const r = await getRepo();
      await r.patch(DEDUPLICATE_NAME, { paused: value });
    } catch {
      /* best-effort — in-memory state already applied; next boot re-reads */
    }
  };

  stageRegistry.register(DEDUPLICATE_NAME, {
    targetVersion: 1,
    dependsOn: [], // not a claim stage
    getInFlight: () => (running ? 1 : 0),
    getThroughput: () => throughput.countInWindow(),
    getPaused: () => paused,
    reloadConfig: loadPaused,
    pause: async () => {
      paused = true;
      await persistPaused(true);
      log.info('deduplicate paused');
    },
    resume: async () => {
      paused = false;
      await persistPaused(false);
      log.warn('deduplicate RESUMED — duplicate originals will be moved into _duplicates/');
    },
  });

  const ready = loadPaused();

  // Throttled cross-process pause poller (2s) — a pause written by the API
  // process takes effect on the next tick with no IPC. Same as missing-reaper.
  const pollPaused = makePausedPoller(DEDUPLICATE_NAME, paused);

  /** One unit of work: re-check pause state, then run a pass if not paused.
   * Returns how long the loop should sleep before the next call — PAUSED_POLL_MS
   * while paused (so a resume is seen within ~5 s), intervalMs after a pass. */
  const tick = async (): Promise<number> => {
    if (stopped || running) return PAUSED_POLL_MS;
    running = true;
    try {
      paused = await pollPaused();
      if (paused) return PAUSED_POLL_MS; // `finally` still clears `running`
      const cfg = await loadDeDuplicateConfig();
      const summary = await runDeDuplicateOnce({
        batchSize: cfg.batch_size,
        dryRun: cfg.dry_run,
      });
      for (let i = 0; i < summary.deduped; i++) throughput.record(new Date());
      stageRegistry.clearError(DEDUPLICATE_NAME);
      return intervalMs;
    } catch (err) {
      stageRegistry.recordError(DEDUPLICATE_NAME, err instanceof Error ? err.message : String(err));
      log.error({ err }, 'deduplicate tick crashed');
      return intervalMs; // back off after an error just like after a normal pass
    } finally {
      running = false;
    }
  };

  // Adaptive loop: poll at PAUSED_POLL_MS while paused (≤5 s resume latency),
  // sleep intervalMs between actual work passes. Fires immediately on startup
  // (after loadPaused resolves) so a resumed worker doesn't wait the full
  // interval before its first pass.
  let loopTimer: ReturnType<typeof setTimeout> | null = null;
  const loop = async (): Promise<void> => {
    if (stopped) return;
    const delay = await tick();
    if (!stopped) loopTimer = setTimeout(() => void loop(), delay);
  };
  // Delay the first tick until the persisted pause state has been adopted,
  // so the very first pass already knows whether the worker is paused.
  void ready.then(() => {
    if (!stopped) loopTimer = setTimeout(() => void loop(), 0);
  });

  log.info(
    { intervalMs },
    'deduplicate worker started (paused by default — resume from /settings/workers)',
  );

  return {
    stop: () => {
      stopped = true;
      if (loopTimer !== null) clearTimeout(loopTimer);
      stageRegistry.unregister(DEDUPLICATE_NAME);
    },
    ready,
  };
}
