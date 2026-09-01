/**
 * Asset-level relocate (#2629) — the Mongo-aware orchestrator built on the
 * generic crash-safe `relocateFile` primitive (`fs/relocate.ts`). This is
 * the foundation every other file-management feature (rename, move,
 * drag-to-folder, folder move) is meant to call into — see
 * docs/superpowers/specs/2026-08-04-file-management-design.md
 * § "Core architecture" → "The relocate primitive".
 *
 * Resolves the asset's current primary `fileinfo` entry, computes the
 * destination absolute path, and wires the DB repoint (path/filename +
 * thumb/preview stage-version reset + meili re-arm, mirroring the shape
 * `workers/migration/move-backup-asset.ts` already uses) as the
 * primitive's `onVerified` hook — so the write lands strictly BETWEEN the
 * verified copy and the delete-of-original. That ordering is the
 * load-bearing failure-direction contract: any failure up to and including
 * a failed repoint leaves the original completely untouched (at worst a
 * harmless duplicate copy sits at the destination).
 *
 * Deliberately does NOT (yet) handle the `apple_rendered_path` companion or
 * the byte-identical dedupe short-circuit that
 * `workers/migration/move-backup-asset.ts` (`moveBackupAsset`) implements
 * for the geo-relocate route (`routes/library-relocate.ts`). Both are
 * outside this ticket's (#2629) 8-step contract, and `moveBackupAsset` is
 * also shared with the just-landed day-dir-refile migration
 * (`workers/migration/refile-legacy-daydir.ts`) — rewriting its call site
 * risked either silently orphaning Apple-rendered companions for backed-up
 * assets or regressing that migration. `routes/library-relocate.ts` is left
 * calling `moveBackupAsset` as-is; generalizing this primitive to subsume
 * it is tracked as a follow-up: #2667.
 */

import * as path from 'node:path';
import type { ObjectId } from 'mongodb';
import { assetsCollection } from '../db/client.ts';
import { loadLibraryRoots } from '../indexer/libraries.cache.ts';
import { MEILI_REARM_SET } from '../people/people-search-reindex.ts';
import { relocateFile, type CollisionPolicy, type RelocateMode } from '../fs/relocate.ts';
import { resolveRelPathUnderRoot } from './address.ts';
import { isSafeFilename } from '../backup/path-formatter.ts';
import { child as childLogger } from '../log.ts';
import { relocateCacheStageResetSet, liveFileinfoMatchFilter } from '../db/relocate-cache-reset.ts';
import type { AssetDoc, FileInfo } from '../db/schema.ts';

const log = childLogger('library/relocate-asset');

export interface RelocateAssetInput {
  id: ObjectId;
  mode: RelocateMode;
  collision: CollisionPolicy;
  /** POSIX relative dir the destination lives in, relative to
   * `destinationLibraryId`'s root when given, otherwise the asset's OWN
   * library root. `''` = that root. Defaults to the asset's CURRENT
   * relPath — i.e. omitting it makes this call a same-folder rename, per
   * the design doc's "rename IS relocate(sameFolder, newName, move)"
   * framing (`routes/assets/rename.ts`, #2636). */
  destinationPath?: string;
  /** Defaults to the asset's current filename. */
  destinationFilename?: string;
  /** #2725: which library `destinationPath` is relative to. Omit for a
   * same-library relocate (the historical default, and still what every
   * existing caller does). When given and it differs from the asset's own
   * library, this is a cross-library move: the file is copied/moved under
   * the NAMED library's root and the asset's `fileinfo` entry is repointed
   * to that library, not just to a new path within its old one. Before this
   * field existed, a caller with no way to express "library B" would have a
   * same-library-shaped `destinationPath` silently resolved and applied
   * under the SOURCE library's root instead — the live misplacement bug
   * this field closes. */
  destinationLibraryId?: ObjectId;
}

export type RelocateAssetResult =
  | {
      kind: 'relocated';
      newAbsPath: string;
      newPath: string;
      newFilename: string;
      renamedOnCollision: boolean;
      /** The filename the asset had immediately before this relocate — lets
       * a caller (e.g. `routes/assets/rename.ts`) detect an extension
       * change without a separate lookup. */
      oldFilename: string;
    }
  | { kind: 'skipped'; reason: string }
  | { kind: 'not-found' }
  /** `destinationPath` / `destinationFilename` failed validation — a
   * client-error (400-shaped), distinct from `'error'`'s internal-failure
   * (500-shaped) so callers like `routes/assets/relocate.ts` can map it
   * correctly. Enforced here as defense in depth regardless of whether the
   * caller (e.g. the HTTP route) already validated. */
  | { kind: 'invalid'; error: string }
  /** `collision: 'replace'` resolved to a destination already occupied by a
   * DIFFERENT live, indexed asset (#2843). Refused rather than published —
   * `replace` is only safe when the destination is untracked (an ordinary
   * file the indexer hasn't (yet) catalogued, or nothing at all); replacing
   * a tracked asset's bytes out from under its own Mongo row is silent data
   * loss (stale sidecar unlinked, occupant's row left pointing at someone
   * else's pixels). 409-shaped so the caller's collision prompt (Skip /
   * Replace / Keep Both) can re-ask with the occupant identified, rather
   * than the client having to guess why a normally-200 request failed. */
  | { kind: 'occupied'; occupiedByAssetId: string }
  | { kind: 'error'; error: string };

/** Canonical live fileinfo entry. Prefers a non-deleted entry that is NOT
 * missing-tagged, falling back to any non-deleted entry only when every
 * live entry is missing-tagged. The plain "first non-deleted" selector that
 * `routes/library-relocate.ts` / `workers/migration/move-backup-asset.ts`
 * keep copies of was identified as unsafe for multi-location assets in the
 * refile-legacy-daydir review (7173f5e6f): when an earlier entry is
 * missing-tagged but not deleted, it targets the stale/offline copy instead
 * of the live one. */
export function activeFileInfo(asset: Pick<AssetDoc, 'fileinfo'>): FileInfo | null {
  const list = asset.fileinfo ?? [];
  const live = list.filter((entry) => !entry.deleted_at);
  return live.find((entry) => !entry.missing_since) ?? live[0] ?? null;
}

/** Id (as a hex string) of the live, indexed asset — other than `excludeId`
 * — that already occupies `(library_id, path, filename)`, or `null` if the
 * destination is unoccupied by any tracked asset (an ordinary untracked
 * file, or nothing at all — both are `copyVerifiedIntoPlace`'s legitimate
 * `'replace'` case).
 *
 * "Live" here means BOTH: the fileinfo entry itself is not tagged
 * `deleted_at` (mirrors the `$elemMatch` shape `repointToNewLocation` /
 * `workers/migration/move-backup-asset.ts` / `db/assets.repo.ts`'s
 * `findDetailByAddress` all use for "the entry that currently names this
 * path"), AND the asset's own top-level `deleted_at` is unset — a trashed
 * asset's fileinfo entry stays entry-level-live but is repointed at the
 * trash location (see `workers/live-location-count.test.ts`), so in the
 * ordinary case it can never collide with a real destination path; the
 * top-level check is defense in depth against exactly that path somehow
 * coinciding, matching the issue's "live (deleted_at: null) asset" framing. */
async function findLiveOccupant(
  c: Awaited<ReturnType<typeof assetsCollection>>,
  libraryId: ObjectId,
  destPath: string,
  destFilename: string,
  excludeId: ObjectId,
): Promise<string | null> {
  const occupant = await c.findOne(
    {
      _id: { $ne: excludeId },
      deleted_at: null,
      fileinfo: {
        $elemMatch: {
          library_id: libraryId,
          path: destPath,
          filename: destFilename,
          deleted_at: null,
        },
      },
    },
    { projection: { _id: 1 } },
  );
  return occupant ? occupant._id.toHexString() : null;
}

/** #2843: the `'occupied'` result to short-circuit `relocateAsset` with, or
 * `null` when the relocate may proceed as normal — either the collision
 * policy isn't `'replace'` (the only policy that overwrites the
 * destination; see the call site's comment), or `'replace'`'s destination
 * turned out free/untracked (the legitimate case). Split out of
 * `relocateAsset` itself to keep that function's branching flat — this
 * whole check is one self-contained early-exit. */
async function occupiedResultIfReplaceBlocked(
  c: Awaited<ReturnType<typeof assetsCollection>>,
  input: RelocateAssetInput,
  destLibraryId: ObjectId,
  destLibRoot: string,
  destAbsPath: string,
): Promise<Extract<RelocateAssetResult, { kind: 'occupied' }> | null> {
  if (input.collision !== 'replace') return null;
  const destSplit = splitRelPath(destLibRoot, destAbsPath);
  const occupiedByAssetId = await findLiveOccupant(
    c,
    destLibraryId,
    destSplit.relPath,
    destSplit.filename,
    input.id,
  );
  if (!occupiedByAssetId) return null;
  log.warn(
    { id: input.id.toHexString(), occupiedByAssetId, destAbsPath },
    'relocateAsset: replace refused — destination occupied by a different live asset',
  );
  return { kind: 'occupied', occupiedByAssetId };
}

/** Split an absolute path back into the `(path, filename)` shape
 * `FileInfo` stores, POSIX-separated per the schema's storage contract. */
function splitRelPath(libRoot: string, absPath: string): { relPath: string; filename: string } {
  const rel = path.relative(libRoot, absPath).split(path.sep).join('/');
  const lastSlash = rel.lastIndexOf('/');
  return lastSlash === -1
    ? { relPath: '', filename: rel }
    : { relPath: rel.slice(0, lastSlash), filename: rel.slice(lastSlash + 1) };
}

/** Where a relocate's source and destination live on disk, resolved and
 * validated up front — a `library_id`/`destinationPath`/`destinationFilename`
 * triple can fail in several independent ways (unknown source/destination
 * library, a hostile `destinationPath`, an unsafe `destinationFilename`).
 * Split into `resolveLibraryRoots` (which library owns which root) and
 * `resolveDestinationAbsPath` (validating the relPath/filename within that
 * root) so neither half re-accumulates the other's branching — together
 * they keep every individual function under the complexity threshold
 * (#2725 fallow-audit). */
type DestinationPlan = {
  destLibraryId: ObjectId;
  destLibRoot: string;
  sourceAbsPath: string;
  destAbsPath: string;
};

type LibraryRoots = { libRoot: string; destLibraryId: ObjectId; destLibRoot: string };

/** Which on-disk root the asset's OWN library resolves to, and which root
 * `destinationPath` resolves against — the NAMED destination library's root
 * when the caller gives one, not always the asset's own (source) library
 * root. That "always source" behavior was the cross-library misplacement
 * bug (#2725): a caller with a destination relPath meant for a different
 * library had no way to say so, and it got applied under the wrong root
 * with no error. Omitting `destinationLibraryId` keeps the historical
 * same-library behavior for every existing caller. */
async function resolveLibraryRoots(
  input: RelocateAssetInput,
  primary: FileInfo,
): Promise<LibraryRoots | Extract<RelocateAssetResult, { kind: 'error' | 'invalid' }>> {
  const libs = await loadLibraryRoots();
  const libRoot = libs.get(primary.library_id.toHexString());
  if (!libRoot) return { kind: 'error', error: 'library root not found for asset' };

  const destLibraryId = input.destinationLibraryId ?? primary.library_id;
  const destLibRoot = libs.get(destLibraryId.toHexString());
  if (!destLibRoot) return { kind: 'invalid', error: 'destination library not found' };

  return { libRoot, destLibraryId, destLibRoot };
}

/** Validate BOTH destination parts before touching disk, and join them into
 * the destination's absolute path. `destinationPath` is a multi-segment
 * relPath (jailed via the same symlink-safe check the M1 addressing routes
 * share — `resolveRelPathUnderRoot`, tolerant of the destination not
 * existing yet); `destinationFilename` is a single segment, so it gets the
 * stricter no-separators `isSafeFilename` check instead (a relPath jail
 * would happily accept `sub/dir.dng` as a "filename", which is exactly the
 * traversal this guards against). */
async function resolveDestinationAbsPath(
  input: RelocateAssetInput,
  primary: FileInfo,
  destLibRoot: string,
): Promise<string | Extract<RelocateAssetResult, { kind: 'invalid' }>> {
  const destinationPath = input.destinationPath ?? primary.path;
  let destDir: string;
  try {
    destDir = await resolveRelPathUnderRoot(destLibRoot, destinationPath);
  } catch (err) {
    return { kind: 'invalid', error: err instanceof Error ? err.message : String(err) };
  }
  if (input.destinationFilename !== undefined && !isSafeFilename(input.destinationFilename)) {
    return { kind: 'invalid', error: 'destinationFilename is not a valid single-segment filename' };
  }
  const destFilename = input.destinationFilename ?? primary.filename;
  return path.join(destDir, destFilename);
}

async function resolveDestinationPlan(
  input: RelocateAssetInput,
  primary: FileInfo,
): Promise<DestinationPlan | Extract<RelocateAssetResult, { kind: 'error' | 'invalid' }>> {
  const roots = await resolveLibraryRoots(input, primary);
  if ('kind' in roots) return roots;
  const { libRoot, destLibraryId, destLibRoot } = roots;

  const destAbsPath = await resolveDestinationAbsPath(input, primary, destLibRoot);
  if (typeof destAbsPath !== 'string') return destAbsPath;

  const sourceAbsPath = path.join(libRoot, primary.path, primary.filename);
  return { destLibraryId, destLibRoot, sourceAbsPath, destAbsPath };
}

/** The `onVerified` hook `relocateFile` runs between the verified copy and
 * the delete, for `mode: 'move'` only — repoints the DB `fileinfo` entry
 * (including, per #2725, `library_id` for a cross-library move) and resets
 * the cache-writing stages. Split out of `relocateAsset` alongside
 * `resolveDestinationPlan` to keep that function's own size/complexity down. */
function buildRepointHook(
  c: Awaited<ReturnType<typeof assetsCollection>>,
  input: RelocateAssetInput,
  primary: FileInfo,
  destLibraryId: ObjectId,
  destLibRoot: string,
): (info: { newAbsPath: string }) => Promise<void> {
  return async ({ newAbsPath }) => {
    const split = splitRelPath(destLibRoot, newAbsPath);
    const set: Record<string, unknown> = {
      // #2725: repoint library_id too — a plain path/filename repoint left
      // a cross-library move's fileinfo entry claiming the OLD library
      // while the bytes now live under the new one.
      'fileinfo.$.library_id': destLibraryId,
      'fileinfo.$.path': split.relPath,
      'fileinfo.$.filename': split.filename,
      'fileinfo.$.missing_since': null,
      ...MEILI_REARM_SET,
      ...relocateCacheStageResetSet(),
    };
    const res = await c.updateOne(liveFileinfoMatchFilter(input.id, primary), {
      $set: set,
    } as never);
    if (res.matchedCount === 0) {
      throw new Error('asset fileinfo entry changed concurrently — aborting relocate');
    }
  };
}

export async function relocateAsset(input: RelocateAssetInput): Promise<RelocateAssetResult> {
  const c = await assetsCollection();
  const doc = await c.findOne({ _id: input.id });
  if (!doc) return { kind: 'not-found' };

  const primary = activeFileInfo(doc);
  if (!primary) return { kind: 'error', error: 'asset has no live location' };

  const plan = await resolveDestinationPlan(input, primary);
  if ('kind' in plan) return plan;
  const { destLibraryId, destLibRoot, sourceAbsPath, destAbsPath } = plan;

  if (sourceAbsPath === destAbsPath) {
    return { kind: 'skipped', reason: 'already at destination' };
  }

  // #2843: `'replace'` is the one collision policy that overwrites whatever
  // sits at the destination — `fs/relocate.ts`'s `copyVerifiedIntoPlace` is
  // deliberately DB-unaware and will happily publish over ANY file there,
  // and (when the incoming asset has no sidecar) unlink whatever `.xmp` sits
  // alongside it. `'auto-suffix'` / `'keep-both'` never reach an occupied
  // path (they suffix around it) and `'skip'` is a no-op, so this check is
  // scoped to `'replace'` alone — see `occupiedResultIfReplaceBlocked`.
  const occupied = await occupiedResultIfReplaceBlocked(
    c,
    input,
    destLibraryId,
    destLibRoot,
    destAbsPath,
  );
  if (occupied) return occupied;

  // The DB repoint below is a MOVE-only concern: a copy leaves the source
  // asset exactly where it is (same path, same caches, same search rows),
  // and the duplicate file at the destination is discovered by the indexer
  // like any other new file — the filesystem is authoritative, the catalog
  // is a cache of it. Wiring the repoint unconditionally would re-address
  // the ORIGINAL asset doc at the copy's location and catalog-orphan the
  // untouched source file.
  const repointToNewLocation = buildRepointHook(c, input, primary, destLibraryId, destLibRoot);

  const outcome = await relocateFile({
    sourceAbsPath,
    destAbsPath,
    mode: input.mode,
    collision: input.collision,
    callerTag: 'relocateAsset',
    ...(input.mode === 'move' ? { onVerified: repointToNewLocation } : {}),
  });

  switch (outcome.kind) {
    case 'relocated': {
      const split = splitRelPath(destLibRoot, outcome.newAbsPath);
      log.info(
        {
          id: input.id.toHexString(),
          newAbsPath: outcome.newAbsPath,
          mode: input.mode,
        },
        'relocateAsset: relocated',
      );
      return {
        kind: 'relocated',
        newAbsPath: outcome.newAbsPath,
        newPath: split.relPath,
        newFilename: split.filename,
        renamedOnCollision: outcome.renamedOnCollision,
        oldFilename: primary.filename,
      };
    }
    case 'skipped':
      return { kind: 'skipped', reason: outcome.reason };
    case 'error':
      return { kind: 'error', error: outcome.error };
  }
}
