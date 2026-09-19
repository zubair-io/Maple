/**
 * Asset-level relocate (#2629) — the catalogue-aware orchestrator built on the
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
 * #2667: also accepts an optional `renderedCompanionAbsPath` — a PhotoKit
 * backup's Apple-rendered JPEG companion (`apple_rendered_path`), carried
 * alongside the primary + sidecars via `fs/relocate.ts`'s
 * `extraCompanionAbsPaths` and written back to `apple_rendered_path` in the
 * SAME repoint write as everything else. `routes/library-relocate.ts` (the
 * on-demand geo-relocate route) is built on this. The byte-identical dedupe
 * short-circuit `workers/migration/move-backup-asset.ts` (`moveBackupAsset`)
 * also implements is deliberately NOT reproduced here — it is
 * content-identity semantics specific to that one caller, not a generic
 * relocate concern, so it stays a caller-side pre-check
 * (`library/relocate-geo.ts`) before this function is even called.
 * `moveBackupAsset` itself is unchanged and still used as-is by the
 * day-dir-refile migration (`workers/migration/refile-legacy-daydir.ts`).
 */

import * as path from 'node:path';
import type { ObjectId } from '../db/object-id.ts';
import { loadAssetLocationView } from '../db/repos/assets.locations.repo.ts';
import { findLiveOccupantAssetId, repointAssetLocation } from '../db/repos/assets.relocate.repo.ts';
import { loadLibraryRoots } from '../indexer/libraries.cache.ts';
import {
  relocateFile,
  type CollisionPolicy,
  type RelocateMode,
  type RelocateVerifiedInfo,
} from '../fs/relocate.ts';
import { resolveRelPathUnderRoot } from './address.ts';
import { isSafeFilename } from '../backup/path-formatter.ts';
import { child as childLogger } from '../log.ts';
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
  /** Absolute path of the asset's Apple-rendered JPEG companion
   * (`apple_rendered_path`), if any — carried alongside the primary +
   * sidecars the same way a `.xmp` sidecar is (#2667). `null`/omitted for
   * an asset with no such companion. The caller is responsible for
   * resolving the doc's `apple_rendered_path` to an absolute path (and for
   * confirming it exists on disk) before passing it — this function is
   * asset-shape-agnostic beyond that. */
  renderedCompanionAbsPath?: string | null;
  /** Override for which `fileinfo` entry to treat as the asset's active
   * location, bypassing this function's own `activeFileInfo(doc)`
   * resolution (which EXCLUDES an entry tagged `missing_since`, falling
   * back to it only when every live entry is missing-tagged). Pass this
   * when the caller's own selection semantics legitimately differ — e.g.
   * the on-demand geo-relocate route (`library/relocate-geo.ts`), whose own
   * `assetActiveFileInfo` deliberately INCLUDES a missing-tagged entry (a
   * file the client has since restored on disk is still a valid relocation
   * candidate). Without this override, a multi-location asset where the
   * caller's chosen entry is missing-tagged but a DIFFERENT entry is clean
   * would silently relocate the WRONG location (found in review on #2667).
   * Omit for the default (and historically only) behavior. */
  activeFileInfoOverride?: FileInfo;
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
   * a tracked asset's bytes out from under its own database row is silent data
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

/** #2843: the `'occupied'` result to short-circuit `relocateAsset` with, or
 * `null` when the relocate may proceed as normal — either the collision
 * policy isn't `'replace'` (the only policy that overwrites the
 * destination; see the call site's comment), or `'replace'`'s destination
 * turned out free/untracked (the legitimate case). Split out of
 * `relocateAsset` itself to keep that function's branching flat — this
 * whole check is one self-contained early-exit. */
async function occupiedResultIfReplaceBlocked(
  input: RelocateAssetInput,
  destLibraryId: ObjectId,
  destLibRoot: string,
  destAbsPath: string,
): Promise<Extract<RelocateAssetResult, { kind: 'occupied' }> | null> {
  if (input.collision !== 'replace') return null;
  const destSplit = splitRelPath(destLibRoot, destAbsPath);
  const occupiedByAssetId = await findLiveOccupantAssetId(
    { libraryId: destLibraryId, path: destSplit.relPath, filename: destSplit.filename },
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
 * the delete, for `mode: 'move'` only — repoints the location row
 * (including, per #2725, `library_id` for a cross-library move) and resets
 * the cache-writing stages. Split out of `relocateAsset` alongside
 * `resolveDestinationPlan` to keep that function's own size/complexity down.
 *
 * The old address goes into the repoint's own `WHERE`, which is what makes a
 * row count of zero mean "the entry changed underneath us" rather than "the
 * write did nothing". See `db/repos/assets.relocate.repo.ts`. */
function buildRepointHook(
  input: RelocateAssetInput,
  primary: FileInfo,
  destLibraryId: ObjectId,
  destLibRoot: string,
): (info: RelocateVerifiedInfo) => Promise<void> {
  return async ({ newAbsPath, companionPaths }) => {
    const split = splitRelPath(destLibRoot, newAbsPath);
    // #2667: only touch `apple_rendered_path` when the companion actually
    // copied — a companion that was REQUESTED but failed to copy (best-effort,
    // `fs/relocate.ts`'s `tryCopyCompanion`) leaves `companionPaths` empty, and
    // omitting the field here means the stored value is left exactly as it
    // was, matching `moveBackupAsset`'s same "unchanged on a companion that
    // didn't move" behavior.
    //
    // `companionPaths[0]` (rather than matching by source path) is safe
    // ONLY because this call site ever passes exactly ONE entry into
    // `extraCompanionAbsPaths` (`renderedCompanionAbsPath` above, singular)
    // — `fs/relocate.ts` preserves input order and only pushes a SUCCESSFUL
    // copy's destination, so with a single input there is no other entry it
    // could be (reviewed on #2667). If a second companion type is ever
    // added to this call site, `fs/relocate.ts` would need to return
    // source→dest pairs instead of a bare array, and this line would need
    // to match on source path rather than position — don't reuse this
    // pattern for a multi-companion caller without making that change.
    const companion =
      input.renderedCompanionAbsPath && companionPaths[0]
        ? path.relative(destLibRoot, companionPaths[0]).split(path.sep).join('/')
        : undefined;

    const repointed = await repointAssetLocation({
      id: input.id,
      from: {
        libraryId: primary.library_id,
        path: primary.path,
        filename: primary.filename,
      },
      // #2725: repoint library_id too — a plain path/filename repoint left
      // a cross-library move's location claiming the OLD library while the
      // bytes now live under the new one.
      to: { libraryId: destLibraryId, path: split.relPath, filename: split.filename },
      ...(companion === undefined ? {} : { appleRenderedPath: companion }),
    });
    if (!repointed) {
      throw new Error('asset fileinfo entry changed concurrently — aborting relocate');
    }
  };
}

export async function relocateAsset(input: RelocateAssetInput): Promise<RelocateAssetResult> {
  const view = await loadAssetLocationView(input.id);
  if (!view) return { kind: 'not-found' };

  const primary = input.activeFileInfoOverride ?? activeFileInfo(view);
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
  const repointToNewLocation = buildRepointHook(input, primary, destLibraryId, destLibRoot);

  const outcome = await relocateFile({
    sourceAbsPath,
    destAbsPath,
    mode: input.mode,
    collision: input.collision,
    callerTag: 'relocateAsset',
    extraCompanionAbsPaths: input.renderedCompanionAbsPath
      ? [input.renderedCompanionAbsPath]
      : undefined,
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
