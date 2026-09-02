/**
 * Async phase helpers for `dedupe.ts`'s `processAsset` — stat'ing live entries
 * on disk, tagging/validating absent ones, resolving `.keep`-pinned keepers,
 * and the two Mongo/fs mutation passes (move-to-`_duplicates/`, `$pull` from
 * `fileinfo`). Split out purely to keep `processAsset` itself a short,
 * readable orchestrator over these phases (#1988, fallow CRITICAL complexity)
 * — none of this is meant to be called from anywhere but `dedupe.ts`.
 *
 * Every function here is a single phase of the pipeline `processAsset` runs
 * in order; see that function's own comments for why each phase exists and
 * what it guards against. No behavior changed in this split — every branch,
 * early return, and side-effect ordering is preserved exactly.
 */

import * as path from 'node:path';
import type { ObjectId } from 'mongodb';
import type { assetsCollection } from '../db/client.ts';
import * as fs from '../fs/mirrored.ts';
import { updateLiveLocationCount, assetPrimaryFileInfo } from '../indexer/images.repo.ts';
import type { AssetDoc, FileInfo } from '../db/schema.ts';
import { child as childLogger } from '../log.ts';
import { statKind, libraryRootAvailable } from './missing-reaper.helpers.ts';
import { moveToDuplicates, directoryHasKeepFile } from '../fs/duplicates.ts';
import { cleanPreviewsCacheForLocation } from '../fs/preview-cache-cleanup.ts';
import {
  folderKey,
  sameEntry,
  selectKeeper,
  reArmCacheStages,
  type DeDuplicateSummary,
} from './dedupe.helpers.ts';

const log = childLogger('deduplicate');

/** Minimal projected shape `processAsset` needs from each candidate row —
 * mirrors `DedupeCandidate` in `dedupe.ts` without importing it (that file
 * imports this one). */
interface DedupeAssetRef {
  _id: ObjectId;
  maple_id?: string | null;
}

type AssetsCollection = Awaited<ReturnType<typeof assetsCollection>>;

/** POSIX `path` field → segment array, matching how `fileinfo.path` is stored. */
function pathSegments(p: string): string[] {
  return p === '' ? [] : p.split('/');
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
 * cooldown period. Only stamps entries that are NOT already tagged —
 * resetting `missing_since` on every pass would restart the reaper's cooldown
 * clock, preventing stale entries from ever aging out. Recomputes the live
 * count afterward, but only if the tag write actually applied.
 */
async function tagAbsentEntries(
  coll: AssetsCollection,
  assetId: ObjectId,
  absentEntries: FileInfo[],
): Promise<void> {
  const now = new Date().toISOString();
  const tagged = await coll
    .updateOne(
      { _id: assetId },
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
              { $or: [{ 'e.missing_since': { $exists: false } }, { 'e.missing_since': null }] },
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
        { _id: String(assetId), err: err instanceof Error ? err.message : err },
        'deduplicate: failed to tag absent entries',
      );
      return false;
    });
  if (tagged) {
    await updateLiveLocationCount(coll, assetId).catch((err) => {
      log.warn(
        { _id: String(assetId), err: err instanceof Error ? err.message : err },
        'deduplicate: failed to recompute live_location_count after tagging',
      );
    });
  }
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
  coll: AssetsCollection,
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
    if (!dryRun) await tagAbsentEntries(coll, assetId, absentEntries);
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
 * than trusting the stored `fileinfo.keep` flag, which can go stale if the
 * marker was added or removed after the file was first indexed. Folders are
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
 * Pulls the moved entries from `fileinfo`, one `$pull` per entry.
 *
 * MongoDB does NOT support `$or` inside a `$pull` filter expression — it is
 * silently ignored and the update modifies 0 documents (the file gets moved
 * but the DB entry stays, so the asset keeps showing as a duplicate). The
 * correct approach for compound-key matches is one `$pull` per entry.
 *
 * The cache-stage re-arm (`$set`) is fused into the first pull so it lands
 * atomically with the first fileinfo removal. Subsequent pulls are pure
 * `$pull` calls (one round-trip each; typically only one or two entries).
 */
export async function pullMovedEntriesFromFileinfo(
  coll: AssetsCollection,
  assetId: ObjectId,
  moved: FileInfo[],
  anchorMoves: boolean,
): Promise<void> {
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
    await coll.updateOne({ _id: assetId }, pullUpdate as never);
  }
  // Recompute live count after pulling moved entries from fileinfo.
  await updateLiveLocationCount(coll, assetId);
}
