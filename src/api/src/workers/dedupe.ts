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
 * Which copy is KEPT (the spec's ranking — see `selectKeeper` / `dedupe.helpers.ts`):
 *   1. prefer to move a copy under an `unsorted` folder
 *   2. then a `name.N.ext` numbered copy
 *   3. then an all-numeric directory path
 *   4. otherwise keep the LAST copy in the list
 *
 * Derived data:
 *   - XMP sidecars travel into `_duplicates` alongside the moved file (edits
 *     preserved & restorable) via `moveToDuplicates`.
 *   - Thumbs/previews are `maple_id`-keyed and SHARED by every location, so the
 *     moved copy's folder cache is cleaned only when the kept copy is NOT in
 *     that folder. When the cache anchor (`fileinfo[0]`) is one of the moved
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
import { isLiveFileInfo, assetPrimaryFileInfo } from '../indexer/images.repo.ts';
import { recordAndPublishAssetChange } from '../db/changes.repo.ts';
import type { AssetDoc, FileInfo } from '../db/schema.ts';
import { child as childLogger } from '../log.ts';
import { stageRegistry } from './registry.ts';
import { ThroughputWindow } from './run-stage.ts';
import { WorkerConfigRepo, type WorkerConfigDoc } from './worker-config.repo.ts';
import { makePausedPoller } from './paused-poller.ts';
import { statKind } from './missing-reaper.helpers.ts';
import { moveToDuplicates } from '../fs/duplicates.ts';
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

/** Low-urgency library sweep — a duplicate set is not time-critical. */
const DEFAULT_INTERVAL_MS = 300_000;

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

  // Coarse gate: a 2nd fileinfo entry exists (≡ the operator's
  // `{$expr:{$gt:[{$size:'$fileinfo'},1]}}`), backed by the
  // `fileinfo_multi_location` partial index so it seeks only the rare dup rows.
  // Liveness is refined per-row below (a lone tombstoned sibling doesn't count).
  const candidates = (await coll
    .find({ 'fileinfo.1': { $exists: true } }, { projection: { _id: 1, fileinfo: 1, maple_id: 1 } })
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

  if (summary.scanned > 0) log.info(summary, 'deduplicate pass complete');
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

  // All live entries on one asset share its `maple_id` (that is *why* they are
  // one asset), so they are byte-identical — collapsing to one loses no content.
  const keeper = selectKeeper(liveEntries);
  const keeperKey = folderKey(keeper);
  const removeEntries = liveEntries.filter((e) => !sameEntry(e, keeper));

  // Mount guard: every involved library must be registered, or we can't resolve
  // a source/destination root — skip the whole asset this pass.
  for (const entry of [keeper, ...removeEntries]) {
    if (!libs.get(entry.library_id.toHexString())) {
      summary.skippedOffline++;
      return;
    }
  }

  // Don't move the only on-disk copy while keeping a missing one. Skip if the
  // keeper isn't present: 'absent' → genuinely gone, the reaper retags + we
  // re-pick next pass; 'error' (EACCES/EIO/offline) → unreadable, don't act unproven.
  const keeperRoot = libs.get(keeper.library_id.toHexString())!;
  const keeperSegments = keeper.path === '' ? [] : keeper.path.split('/');
  const keeperAbs = path.join(keeperRoot, ...keeperSegments, keeper.filename);
  const keeperKind = await statKind(keeperAbs);
  if (keeperKind !== 'present') {
    if (keeperKind === 'absent') summary.skippedMissingFile++;
    else summary.skippedOffline++;
    return;
  }

  // The current cache anchor = first live entry. If it is one of the copies we
  // move away, the kept copy's folder has no `maple_id`-keyed thumb/preview, so
  // re-arm those stages to regenerate at the new primary.
  const oldPrimary = assetPrimaryFileInfo(doc as Pick<AssetDoc, 'fileinfo'>)!;
  const anchorMoves = folderKey(oldPrimary) !== keeperKey;

  const moved: FileInfo[] = [];
  for (const entry of removeEntries) {
    const root = libs.get(entry.library_id.toHexString())!;
    const segments = entry.path === '' ? [] : entry.path.split('/');
    const abs = path.join(root, ...segments, entry.filename);

    // Only relocate a present file. 'absent' → stale entry (the discover /
    // missing-reaper path handles it); 'error' → unreadable/offline, never move
    // on unproven absence. Skip just this entry; other copies may still move.
    const kind = await statKind(abs);
    if (kind !== 'present') {
      if (kind === 'absent') summary.skippedMissingFile++;
      else summary.skippedOffline++;
      continue;
    }

    if (dryRun) {
      log.info({ _id: String(doc._id), from: abs }, 'deduplicate dry-run: would move duplicate');
      moved.push(entry);
      continue;
    }

    const res = await moveToDuplicates(abs, root);
    if (res.kind === 'error') {
      summary.errors++;
      log.warn({ _id: String(doc._id), abs, err: res.error }, 'deduplicate: move failed');
      continue;
    }
    summary.movedFiles++;

    // Clean the moved copy's folder cache only when the kept copy is NOT in that
    // folder (else it is the kept copy's live cache and must stay).
    if (doc.maple_id && folderKey(entry) !== keeperKey) {
      await cleanFolderCache(path.dirname(abs), doc.maple_id);
    }
    moved.push(entry);
  }

  if (moved.length === 0) return; // nothing actually moved (all missing / errored)

  if (dryRun) {
    summary.dryRun++;
    return; // no Mongo mutation in dry-run
  }

  // Pull the moved entries from `fileinfo`; re-arm cache stages if the anchor
  // moved. `$pull fileinfo` and `$set stages.*` touch distinct paths → one update.
  const update: Record<string, unknown> = {
    $pull: {
      fileinfo: {
        $or: moved.map((m) => ({ library_id: m.library_id, path: m.path, filename: m.filename })),
      },
    },
  };
  if (anchorMoves) update['$set'] = reArmCacheStages();
  await coll.updateOne({ _id: doc._id }, update as never);
  summary.deduped++;

  // Publish an update keyed by the surviving primary so clients + search refresh.
  await recordAndPublishAssetChange({
    kind: 'update',
    asset_id: doc._id,
    folder_id: keeper.library_id,
    abs_path: keeperAbs,
  });
}

/**
 * Delete the `maple_id`-keyed thumb and every preview/derived variant in one
 * folder's `.maple` cache. Called for a moved copy's folder ONLY when no
 * surviving live entry shares it, so the kept copy's cache is never touched.
 * Best-effort — derived data regenerates.
 */
async function cleanFolderCache(folderAbs: string, mapleId: string): Promise<void> {
  await fs.unlink(path.join(folderAbs, '.maple', 'thumbs', `${mapleId}.jpg`)).catch(() => {});
  const previewsDir = path.join(folderAbs, '.maple', 'previews');
  let entries: string[];
  try {
    entries = await fs.readdir(previewsDir);
  } catch {
    return; // no previews dir here
  }
  // Previews are `<maple_id>_<size>.jpg`; the histogram sidecar is
  // `<maple_id>_histogram.json`. Both share the `<maple_id>_` prefix.
  const prefix = `${mapleId}_`;
  for (const name of entries) {
    if (name.startsWith(prefix)) {
      await fs.unlink(path.join(previewsDir, name)).catch(() => {});
    }
  }
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
  const persistPaused = (value: boolean): void => {
    void getRepo()
      .then((r) => r.patch(DEDUPLICATE_NAME, { paused: value }))
      .catch(() => {
        /* best-effort — in-memory state already applied; next boot re-reads */
      });
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
      persistPaused(true);
      log.info('deduplicate paused');
    },
    resume: async () => {
      paused = false;
      persistPaused(false);
      log.warn('deduplicate RESUMED — duplicate originals will be moved into _duplicates/');
    },
  });

  const ready = loadPaused();

  // Throttled cross-process pause poller (2s) — a pause written by the API
  // process takes effect on the next tick with no IPC. Same as missing-reaper.
  const pollPaused = makePausedPoller(DEDUPLICATE_NAME, paused);

  const tick = async (): Promise<void> => {
    if (stopped || running) return;
    running = true;
    try {
      paused = await pollPaused();
      if (paused) return; // `finally` still clears `running`
      const cfg = await loadDeDuplicateConfig();
      const summary = await runDeDuplicateOnce({ batchSize: cfg.batch_size, dryRun: cfg.dry_run });
      for (let i = 0; i < summary.deduped; i++) throughput.record(new Date());
      stageRegistry.clearError(DEDUPLICATE_NAME);
    } catch (err) {
      stageRegistry.recordError(DEDUPLICATE_NAME, err instanceof Error ? err.message : String(err));
      log.error({ err }, 'deduplicate tick crashed');
    } finally {
      running = false;
    }
  };

  const timer = setInterval(() => {
    void tick();
  }, intervalMs);

  log.info(
    { intervalMs },
    'deduplicate worker started (paused by default — resume from /settings/workers)',
  );

  return {
    stop: () => {
      stopped = true;
      clearInterval(timer);
      stageRegistry.unregister(DEDUPLICATE_NAME);
    },
    ready,
  };
}
