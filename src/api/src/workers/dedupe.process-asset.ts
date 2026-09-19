/**
 * Async phase helpers for `dedupe.ts`'s `processAsset` — stat'ing live entries
 * on disk, tagging/validating absent ones, resolving `.keep`-pinned keepers,
 * and the two database/fs mutation passes (move-to-`_duplicates/`, remove the
 * moved locations). Split out purely to keep `processAsset` itself a short,
 * readable orchestrator over these phases (#1988, fallow CRITICAL complexity)
 * — none of this is meant to be called from anywhere but `dedupe.ts`.
 *
 * Every function here is a single phase of the pipeline `processAsset` runs
 * in order; see that function's own comments for why each phase exists and
 * what it guards against.
 *
 * ## What the SQLite port changed here (#3787)
 *
 * Nothing about the policy — the ranking, the `.keep` pins, the quarantine
 * moves and the cache cleanup are byte-for-byte the same decisions. What went
 * away is the collection handle every phase used to thread through: a location
 * is a row in `asset_locations` now, and the repository functions in
 * `db/sqlite/repos/assets.sweeps.ts` resolve the process-wide database handle
 * themselves, so these phases take an asset id and nothing else.
 */

import * as path from 'node:path';
import type { ObjectId } from '../db/object-id.ts';
import * as fs from '../fs/mirrored.ts';
import { assetPrimaryFileInfo } from '../indexer/images.repo.ts';
import type { AssetDoc, FileInfo } from '../db/schema.ts';
import {
  reconcileLocations,
  tagLocationsMissing,
  type LocationAddress,
} from '../db/sqlite/repos/assets.sweeps.ts';
import {
  stageRearmStatements,
  RELOCATE_CACHE_STAGES,
} from '../db/sqlite/repos/assets.stage-rearm.ts';
import { child as childLogger } from '../log.ts';
import { statKind, libraryRootAvailable } from './missing-reaper.helpers.ts';
import { moveToDuplicates, directoryHasKeepFile } from '../fs/duplicates.ts';
import { cleanPreviewsCacheForLocation } from '../fs/preview-cache-cleanup.ts';
import { folderKey, sameEntry, selectKeeper, type DeDuplicateSummary } from './dedupe.helpers.ts';

const log = childLogger('deduplicate');

/** Why an absent entry was tagged, for the missing-reaper's triage. */
const ABSENT_REASON = 'dedupe-absent';

/** Minimal projected shape `processAsset` needs from each candidate row —
 * mirrors `DuplicateCandidate` in `db/sqlite/repos/assets.sweeps.ts` without
 * requiring the rest of it. */
interface DedupeAssetRef {
  _id: ObjectId;
  maple_id?: string | null;
}

/** POSIX `path` field → segment array, matching how a location's path is stored. */
function pathSegments(p: string): string[] {
  return p === '' ? [] : p.split('/');
}

/** One location as the sweep repository addresses it. */
function locationAddress(entry: FileInfo): LocationAddress {
  return {
    libraryId: entry.library_id.toHexString(),
    path: entry.path,
    filename: entry.filename,
  };
}

/**
 * Identify which of `liveEntries` ACTUALLY EXIST ON DISK before choosing
 * anything to move. A user moving a file makes discover record the new path
 * before its `removed` handler tombstones the old one, so for a window an
 * asset has two "live" entries but only ONE physical file — the caller must
 * never pick a stale entry as the keeper nor move the last real file.
 *
 * Returns `'offline'` when a library root can't be resolved, or a copy can't
 * be stat'd at all (EACCES/EIO/offline mount) — a partial picture the caller
 * must not act on.
 */
async function statLiveEntries(
  liveEntries: FileInfo[],
  libs: ReadonlyMap<string, string>,
): Promise<{ onDisk: FileInfo[]; absentEntries: FileInfo[] } | 'offline'> {
  const onDisk: FileInfo[] = [];
  const absentEntries: FileInfo[] = [];
  for (const entry of liveEntries) {
    const root = libs.get(entry.library_id.toHexString());
    if (!root) return 'offline';
    const kind = await statKind(path.join(root, ...pathSegments(entry.path), entry.filename));
    if (kind === 'present') {
      onDisk.push(entry);
    } else if (kind === 'absent') {
      absentEntries.push(entry);
    } else {
      return 'offline';
    }
  }
  return { onDisk, absentEntries };
}

/**
 * An absent entry is only trustworthy when its library ROOT is available
 * (#2171): an unmounted mount is a present-but-empty dir under which every
 * stat ENOENTs, which must read as "volume gone", not "files deleted".
 */
async function allAbsentEntryRootsAvailable(
  absentEntries: FileInfo[],
  libs: ReadonlyMap<string, string>,
): Promise<boolean> {
  const absentRoots = [...new Set(absentEntries.map((e) => libs.get(e.library_id.toHexString())!))];
  for (const root of absentRoots) {
    if (!(await libraryRootAvailable(root))) return false;
  }
  return true;
}

/**
 * Tag any absent entries so the missing-reaper can prune them after the
 * cooldown period.
 *
 * An entry that already carries a tag keeps its original timestamp — stamping
 * it again on every pass would restart the reaper's cooldown clock and strand
 * the entry on disk forever. That first-detection-wins rule is the statement's
 * own `WHERE … AND missing_since IS NULL` now, rather than the Mongo version's
 * `arrayFilters` condition, so it is enforced by the write instead of by the
 * caller remembering to ask for it.
 *
 * Nothing recomputes the asset's live-location count afterwards: it is a column
 * maintained by triggers on `asset_locations`, so it and the rows it counts
 * commit together and cannot drift.
 */
async function tagAbsentEntries(assetId: ObjectId, absentEntries: FileInfo[]): Promise<void> {
  await tagLocationsMissing(
    assetId.toHexString(),
    absentEntries.map(locationAddress),
    ABSENT_REASON,
  ).catch((err) => {
    log.warn(
      { _id: String(assetId), err: err instanceof Error ? err.message : err },
      'deduplicate: failed to tag absent entries',
    );
  });
}

/**
 * Reason `resolveOnDiskEntries` bails on an asset instead of returning a
 * usable `onDisk` set. `'none'` is the (unreachable in practice, kept for
 * fidelity with the pre-split code) case of fewer than two on-disk copies
 * with zero absent entries — `onDisk.length + absentEntries.length` always
 * equals `liveEntries.length` (≥2 by the time this runs), so `onDisk < 2`
 * implies at least one absent entry; the branch is defensive, not dead.
 */
export type OnDiskSkipReason = 'offline' | 'missingFile' | 'none';

/**
 * Combines the stat / absent-root-validation / absent-tagging / minimum-count
 * phases into the single result `processAsset` branches on: either a usable
 * `onDisk` set (≥2 real copies) or the reason to bail. Bundling these four
 * phases keeps the caller's own branch count down to one dispatch instead of
 * three separate guard clauses.
 */
export async function resolveOnDiskEntries(
  assetId: ObjectId,
  liveEntries: FileInfo[],
  libs: ReadonlyMap<string, string>,
  dryRun: boolean,
): Promise<{ onDisk: FileInfo[] } | { skip: OnDiskSkipReason }> {
  const statResult = await statLiveEntries(liveEntries, libs);
  if (statResult === 'offline') return { skip: 'offline' };
  const { onDisk, absentEntries } = statResult;

  if (absentEntries.length > 0) {
    if (!(await allAbsentEntryRootsAvailable(absentEntries, libs))) return { skip: 'offline' };
    if (!dryRun) await tagAbsentEntries(assetId, absentEntries);
  }

  // Fewer than two copies on disk → not a real duplicate set right now (the
  // extra entries are stale and will be reconciled away by discover / the
  // missing-reaper). This is THE guard against "no file left on disk": the
  // caller never moves anything when only one physical copy exists.
  if (onDisk.length < 2) {
    return { skip: absentEntries.length > 0 ? 'missingFile' : 'none' };
  }
  return { onDisk };
}

/**
 * `.keep` override: any on-disk copy whose folder holds a `.keep` marker is
 * PINNED and must survive. Re-confirmed on disk here (authoritative) rather
 * than trusting the location row's stored `keep` flag, which can go stale if
 * the marker was added or removed after the file was first indexed. Folders are
 * cached so a folder shared by several copies is stat'd once.
 */
async function pinnedEntries(
  onDisk: FileInfo[],
  libs: ReadonlyMap<string, string>,
): Promise<FileInfo[]> {
  const keepByFolder = new Map<string, boolean>();
  const pinned: FileInfo[] = [];
  for (const entry of onDisk) {
    const key = folderKey(entry);
    let isKept = keepByFolder.get(key);
    if (isKept === undefined) {
      const root = libs.get(entry.library_id.toHexString())!;
      isKept = await directoryHasKeepFile(path.join(root, ...pathSegments(entry.path)));
      keepByFolder.set(key, isKept);
    }
    if (isKept) pinned.push(entry);
  }
  return pinned;
}

/**
 * When at least one copy is pinned, keeps EVERY pinned copy and moves the
 * rest. With no marker, falls back to the single-copy keeper ranking
 * (`selectKeeper`). Keepers are guaranteed on-disk; `removeEntries` are the
 * OTHER on-disk ones (all confirmed present) — they share this asset's
 * `maple_id`, so they are byte-identical and collapsing loses no content.
 */
export async function resolveKeepersAndRemovals(
  onDisk: FileInfo[],
  libs: ReadonlyMap<string, string>,
): Promise<{ keepers: FileInfo[]; removeEntries: FileInfo[] }> {
  const pinned = await pinnedEntries(onDisk, libs);
  const keepers = pinned.length > 0 ? pinned : [selectKeeper(onDisk)];
  const removeEntries = onDisk.filter((e) => !keepers.some((k) => sameEntry(e, k)));
  return { keepers, removeEntries };
}

/**
 * The bundle `processAsset` needs from the resolved `keepers` set once
 * `removeEntries` is known non-empty: the representative surviving copy
 * (earliest in `fileinfo` order — used for the change-publish + as the
 * cache-anchor math's reference point when there are multiple keepers), its
 * absolute path, the set of keeper folder keys, and whether the current
 * cache anchor (`fileinfo[0]`) is moving away — which re-arms the
 * location-keyed thumb/preview stages so the kept copy regenerates them.
 */
export function resolveKeeperContext(
  doc: Pick<AssetDoc, 'fileinfo'>,
  keepers: FileInfo[],
  libs: ReadonlyMap<string, string>,
): { primaryKeeper: FileInfo; keeperAbs: string; keeperKeys: Set<string>; anchorMoves: boolean } {
  const primaryKeeper = keepers[0]!;
  const keeperRoot = libs.get(primaryKeeper.library_id.toHexString())!;
  const keeperAbs = path.join(
    keeperRoot,
    ...pathSegments(primaryKeeper.path),
    primaryKeeper.filename,
  );
  const keeperKeys = new Set(keepers.map(folderKey));
  const oldPrimary = assetPrimaryFileInfo(doc)!;
  const anchorMoves = !keeperKeys.has(folderKey(oldPrimary));
  return { primaryKeeper, keeperAbs, keeperKeys, anchorMoves };
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

/**
 * Relocates every entry in `removeEntries` into `_duplicates/` (or logs the
 * intended move under `dryRun`), cleaning each moved copy's preview cache
 * unconditionally and its thumb cache only when no surviving keeper shares
 * its folder. Returns the entries that were actually moved (or would have
 * been, in `dryRun`) — a `moveToDuplicates` failure for one entry is counted
 * and skipped, not fatal to the rest.
 */
export async function moveEntriesToDuplicates(
  doc: DedupeAssetRef,
  removeEntries: FileInfo[],
  libs: ReadonlyMap<string, string>,
  keeperKeys: ReadonlySet<string>,
  dryRun: boolean,
  summary: DeDuplicateSummary,
): Promise<FileInfo[]> {
  const moved: FileInfo[] = [];
  for (const entry of removeEntries) {
    const root = libs.get(entry.library_id.toHexString())!;
    const abs = path.join(root, ...pathSegments(entry.path), entry.filename);

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
    await cleanPreviewsCacheForLocation(root, entry).catch(() => {});
    if (doc.maple_id && !keeperKeys.has(folderKey(entry))) {
      await cleanThumbCache(path.dirname(abs), doc.maple_id);
    }
    moved.push(entry);
  }
  return moved;
}

/**
 * Drop the relocated copies' locations from the asset, and re-arm the
 * location-keyed cache stages when the cache anchor was one of them.
 *
 * One transaction for the whole asset, which is a guarantee the Mongo version
 * could not offer. There it was one `$pull` per entry, and not by choice:
 * MongoDB silently ignores an `$or` inside a `$pull` filter, so a compound-key
 * match written the obvious way removes nothing at all — the file is moved into
 * quarantine while the row still claims it, and the asset keeps reporting as a
 * duplicate forever. That whole class of bug cannot be expressed against rows;
 * each location is one `DELETE … WHERE asset_id = ? AND library_id = ? AND
 * path = ? AND filename = ?` and the batch commits or it does not.
 *
 * The re-arm rides along as `extra` for the same reason it used to be fused
 * into the first `$pull`: a crash between the removal and the re-arm would
 * leave the kept copy's thumb and preview pointing at a folder nothing lives
 * in any more, with nothing queued to regenerate them.
 */
export async function pullMovedEntriesFromFileinfo(
  assetId: ObjectId,
  moved: FileInfo[],
  anchorMoves: boolean,
): Promise<void> {
  const assetIdHex = assetId.toHexString();
  await reconcileLocations({
    assetId: assetIdHex,
    prune: moved.map(locationAddress),
    extra: anchorMoves ? stageRearmStatements(assetIdHex, RELOCATE_CACHE_STAGES) : [],
  });
}
