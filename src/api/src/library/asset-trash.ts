/**
 * Single-asset trash + restore orchestration (#2630) — the database+FS
 * workflow shared by the per-asset HTTP routes (`routes/assets/trash.ts`)
 * and the recursive folder-trash orchestrator (`library/folder-trash.ts`).
 *
 * Factored out so folder trash/restore reuses the EXACT soft-delete /
 * restore workflow a single asset uses — the `moveToTrash`/`moveOutOfTrash`
 * file move (itself built on the generic crash-safe `relocateFile`
 * primitive, `fs/relocate.ts`, #2629), the `markSoftDeleted`/
 * `restoreFromTrash` DB repoint and the change-feed emission — rather than
 * re-implementing a parallel path that could drift from the single-asset
 * one. `routes/assets/trash.ts` calls these two functions directly for its
 * soft-delete / restore branches; the folder orchestrator calls them once
 * per asset under a subtree.
 *
 * Deliberately covers only the SOFT-delete direction of
 * `DELETE /api/assets/:id` (a live asset -> trash) and restore. The
 * permanent-purge branch (an already-trashed asset -> hard delete) stays
 * inline in the route: it has no folder-level analogue in this ticket's
 * scope and pulling it in here would add an unused branch to every caller.
 */

import { isExcludedLocation, type IgnoreVerdictMemo } from '../fs/mapleignore.ts';
import { refusesMoveUnderMarker } from '../fs/mapleignore-guard.ts';
import * as path from 'node:path';
// Read-only re-stat of the restored file — routed through `fs/mirrored.ts`
// (which re-exports the full `node:fs/promises` surface) rather than a
// direct `node:fs/promises` import, per the oxlint fs-import guardrail.
import { stat } from '../fs/mirrored.ts';
import type { ObjectId } from '../db/object-id.ts';
import { findFolderById } from '../db/repos/folders.repo.ts';
import { moveToTrash, moveOutOfTrash } from '../fs/trash.ts';
import { recordAndPublishAssetChange } from '../db/repos/changes.repo.ts';
import {
  findCoreInfoById,
  markSoftDeleted,
  restoreFromTrash,
  restoreBackupDestinationOccupied,
} from '../db/repos/assets.repo.ts';
import {
  prepareLifecycle,
  recordLifecycleTarget,
  finishLocalLifecycle,
  runLifecycleMove,
  lifecycleCommit,
  fenceLifecycleMove,
} from '../cloud-backup/lifecycle.ts';
import type { FileInfo, FolderWithId } from '../db/schema.ts';
import { child as childLogger } from '../log.ts';
import {
  resolveRestoreSource,
  restoreDestinationRefusal,
  type RestoreRefusal,
} from './restore-source.ts';

const log = childLogger('library/asset-trash');

/** Identifies exactly one fileinfo entry: the library it belongs to, plus
 * its `(path, filename)` within that library. The single currency both
 * `trashAssetById` and `restoreAssetById` resolve down to before touching
 * disk or the database — see `resolveEntrySpec`. */
export interface AssetLocationEntry {
  libraryId: ObjectId;
  path: string;
  filename: string;
}

function toEntrySpec(fi: FileInfo | null): AssetLocationEntry | null {
  return fi ? { libraryId: fi.library_id, path: fi.path, filename: fi.filename } : null;
}

/**
 * Prefer a live entry (`!deleted_at`) that is NOT `missing_since`-tagged,
 * falling back to any live entry only when every live entry is
 * missing-tagged. The plain "first non-deleted" pick — `list.find((e) =>
 * !e.deleted_at) ?? list[0]` — is unsafe for multi-location assets: an
 * earlier entry that's missing-tagged but not deleted targets the
 * stale/offline copy instead of the live one. That bug class was fixed for
 * `relocateAsset` by `activeFileInfo` in `library/relocate-asset.ts` after
 * the refile-legacy-daydir review (7173f5e6f), and this trash/restore path
 * had the exact same bug (#2695 review).
 *
 * Replicated here rather than imported: `relocate-asset.ts` doesn't export
 * `activeFileInfo` yet, and the PR that adds the export (#2692) is still
 * in flight — importing from an unmerged branch isn't possible, and
 * editing `relocate-asset.ts` here would conflict with that PR's own
 * changes. TODO: once #2692 lands, replace this with an import from
 * whatever shared module it settles on and delete this copy.
 */
function activeFileInfo(fileinfo: FileInfo[] | undefined): FileInfo | null {
  const live = (fileinfo ?? []).filter((entry) => !entry.deleted_at && !isExcludedLocation(entry));
  return live.find((entry) => !entry.missing_since) ?? live[0] ?? null;
}

/**
 * Resolve WHICH fileinfo entry a trash/restore call acts on, as a single
 * `AssetLocationEntry` every downstream step (file move, DB repoint,
 * folder-root lookup, change-feed folder) then derives from — the ONE
 * source of truth, so the selector and the derivation can't disagree the
 * way they did before #2695's second review round (the selector picked
 * the live entry, but `libraryId`/`assetFolderId` were still taken from
 * the asset's globally-primary `folder_id`).
 *
 * `explicit` is the folder-trash orchestrator's already-known entry
 * (`library/folder-trash.ts` — a multi-location asset's folder-membership
 * query already identified exactly which entry qualifies). Omitted by the
 * single-asset HTTP route, which falls back to `activeFileInfo`.
 */
function resolveEntrySpec(
  fileinfo: FileInfo[] | undefined,
  explicit?: AssetLocationEntry,
  allowExcluded = false,
): AssetLocationEntry | null {
  if (!explicit) return toEntrySpec(activeFileInfo(fileinfo));
  // An explicit entry (folder trash, upload replacement) is held to the same
  // `.mapleignore` exclusion as the default pick (#5398).
  const recorded = (fileinfo ?? []).find(
    (entry) =>
      entry.library_id.equals(explicit.libraryId) &&
      entry.path === explicit.path &&
      entry.filename === explicit.filename,
  );
  return recorded && isExcludedLocation(recorded) && !allowExcluded ? null : explicit;
}

export type TrashAssetOutcome =
  | {
      kind: 'ok';
      assetId: ObjectId;
      folderId: ObjectId;
      newAbsPath: string;
      originalAbsPath: string;
    }
  | { kind: 'not-found' }
  | { kind: 'already-trashed' }
  | { kind: 'no-location' }
  | { kind: 'no-folder' }
  | { kind: 'error'; error: string };

export interface TrashAssetOptions {
  /**
   * Explicit fileinfo entry identifying WHICH location to trash. The
   * folder-trash orchestrator (`library/folder-trash.ts`) always passes
   * this: a multi-location asset (deduped across libraries) may not have
   * its globally "primary" fileinfo entry under the folder being trashed,
   * so the caller must say exactly which entry it means — falling back to
   * `activeFileInfo`'s selection here would risk moving the WRONG file
   * (one outside the folder the user asked to trash). Omitted by the
   * single-asset HTTP route, which falls back to `activeFileInfo`.
   */
  entry?: AssetLocationEntry;
  /** Let `entry` name a `.mapleignore`-excluded location (#5398). Only the
   * upload route sets it, when new bytes replace that exact path: the old
   * bytes go to Trash with their asset, so the stale claim on the path is
   * retired instead of being recovered onto the replacement later. */
  allowExcluded?: true;
  /** Shared across one batch (folder trash) so each directory's marker chain
   * is walked once. */
  ignoreMemo?: IgnoreVerdictMemo;
}

/** The entry a trash call acts on and its library, or the outcome to return
 * instead. Unless `allowExcluded`, the entry's directory is checked on disk
 * for a `.mapleignore` chain right before anything moves (#5398). */
async function trashTarget(
  fileinfo: FileInfo[] | undefined,
  opts: TrashAssetOptions,
): Promise<{ entrySpec: AssetLocationEntry; folder: FolderWithId } | TrashAssetOutcome> {
  const entrySpec = resolveEntrySpec(fileinfo, opts.entry, opts.allowExcluded);
  if (!entrySpec) return { kind: 'no-location' };
  const folder = await findFolderById(entrySpec.libraryId);
  if (!folder) return { kind: 'no-folder' };
  if (
    !opts.allowExcluded &&
    (await refusesMoveUnderMarker(folder.path, entrySpec.path, opts.ignoreMemo))
  ) {
    return { kind: 'error', error: 'the file is under a .mapleignore folder' };
  }
  return { entrySpec, folder };
}

/**
 * Soft-delete one live asset: move its RAW + sidecars into
 * `.maple/trash/<rel>` (via `moveToTrash`), repoint its fileinfo entry and
 * stamp `deleted_at` (via `markSoftDeleted`), and emit a delete change for the
 * File Provider extension.
 * Mirrors the soft-delete branch of `DELETE /api/assets/:id` exactly when
 * called without `opts.entry`.
 */
export async function trashAssetById(
  id: ObjectId,
  opts: TrashAssetOptions = {},
): Promise<TrashAssetOutcome> {
  const info = await findCoreInfoById(id);
  if (!info) return { kind: 'not-found' };
  if (info.deleted_at) return { kind: 'already-trashed' };

  // The ONE entry this call acts on — every step below (file move, DB
  // repoint, folder-root lookup, change-feed folder) derives from THIS,
  // never from `info.folder_id` (the asset's globally-primary library,
  // which can differ for a multi-location asset).
  const resolvedTarget = await trashTarget(info.fileinfo, opts);
  if ('kind' in resolvedTarget) return resolvedTarget;
  const { entrySpec, folder } = resolvedTarget;
  const { libraryId, path: entryPath, filename: entryFilename } = entrySpec;
  const absPathResolved = path.join(folder.path, entryPath, entryFilename);
  const originalAbsPath = absPathResolved;

  const intent = await prepareLifecycle(
    id.toHexString(),
    'trash',
    libraryId.toHexString(),
    path.relative(folder.path, absPathResolved).split(path.sep).join('/'),
  );
  const result = await runLifecycleMove(intent, () =>
    moveToTrash(
      absPathResolved,
      folder.path,
      (target) => recordLifecycleTarget(intent, folder.path, absPathResolved, target),
      () => fenceLifecycleMove(intent),
      async (target) => {
        // Repoint only the matched location after verifying every copied byte,
        // before removing any original. The transaction fences the lease owner.
        await markSoftDeleted({
          id,
          libraryRoot: folder.path,
          libraryId,
          newAbsPath: target,
          originalAbsPath: absPathResolved,
          source: { libraryId, path: entryPath, filename: entryFilename },
          lifecycle: await lifecycleCommit(intent),
        });
      },
    ),
  );
  if (result.kind !== 'ok') {
    await finishLocalLifecycle(intent, true);
    return { kind: 'error', error: result.error };
  }

  await finishLocalLifecycle(intent);

  // Emit a delete change keyed on the path the OS / File Provider knows
  // about (the pre-trash location). The asset row stays for restore.
  // `folder_id` MUST be the library the trashed ENTRY belongs to
  // (`libraryId`, resolved above from `opts.entry` or the active entry) —
  // not `info.folder_id` (the asset's globally-primary library), which
  // disagrees for a multi-location asset whenever the entry actually
  // trashed isn't the primary one. Using the wrong folder here computes a
  // wrong/null `relative_path` downstream and misroutes File Provider
  // invalidations to the wrong client (#2695 review).
  await recordAndPublishAssetChange({
    kind: 'delete',
    asset_id: id,
    folder_id: libraryId,
    abs_path: originalAbsPath,
  }).catch(() => {});

  return {
    kind: 'ok',
    assetId: id,
    folderId: libraryId,
    newAbsPath: result.newAbsPath,
    originalAbsPath,
  };
}

export interface RestoreAssetOptions {
  /** Cross-library restore guard — same semantics as the HTTP route's
   * `target_folder_id` body field: rejected unless it matches the asset's
   * own folder. */
  targetFolderId?: string;
  /** POSIX relative path (under the asset's library root) to restore to,
   * validated the same way as the HTTP route's `target_relative_path`.
   * Defaults to the asset's recorded `original_path`. */
  targetRelativePath?: string;
  /**
   * The trashed location the folder-restore orchestrator
   * (`library/folder-trash.ts`) matched. It must be the copy inside
   * `.maple/trash/`, or the restore is refused (#5405). Without it the
   * restore finds that copy itself. Also bypasses the cross-library guard,
   * since the caller already knows the asset's restore-relevant library.
   */
  entry?: AssetLocationEntry;
}

export type RestoreAssetOutcome =
  | {
      kind: 'ok';
      assetId: ObjectId;
      folderId: ObjectId;
      absPath: string;
      filename: string;
      size: number;
      mtimeMs: number;
    }
  | { kind: 'not-found' }
  | { kind: 'not-trashed' }
  | { kind: 'cross-library'; assetFolderId: string }
  | RestoreRefusal;

type RestoreTargetResolution =
  | { kind: 'ok'; targetAbs: string }
  | { kind: 'cross-library'; assetFolderId: string }
  | { kind: 'invalid'; error: string }
  | { kind: 'error'; error: string };

/**
 * Resolve the absolute path a restore writes to.
 *
 * Cross-library restore guard: Phase 3 only restores into the SAME
 * library the asset belongs to — the server moves the file using the
 * ORIGINAL folder root, so an unguarded caller would silently restore
 * into the wrong place. Skipped when `opts.entry` is given, since the
 * folder-restore orchestrator already resolved the correct library.
 *
 * Then either the validated `targetRelativePath` or, when omitted, the
 * asset's recorded `original_path`.
 */
/** Cross-library restore guard: Phase 3 only restores into the SAME
 * library the asset belongs to. Skipped when `opts.entry` is given, since
 * the folder-restore orchestrator already resolved the correct library. */
function crossLibraryGuard(
  assetFolderId: ObjectId,
  opts: RestoreAssetOptions,
): { kind: 'cross-library'; assetFolderId: string } | null {
  if (
    !opts.entry &&
    typeof opts.targetFolderId === 'string' &&
    opts.targetFolderId.length > 0 &&
    opts.targetFolderId !== assetFolderId.toHexString()
  ) {
    return { kind: 'cross-library', assetFolderId: assetFolderId.toHexString() };
  }
  return null;
}

/** Validate a restore target's relative-path shape: relative, no `.`/`..`
 * segments, no hidden (leading-dot) segments. Split out of
 * `resolveRestoreTarget` purely to keep that function's cyclomatic
 * complexity down — same rules `routes/folders.ts`'s
 * `validateRelPathHeader` enforces for `/mkdir` and `/move`, just with the
 * distinct error strings this route has always returned. */
function validateRestoreRelativePath(
  targetRel: string,
): { ok: true } | { ok: false; error: string } {
  if (targetRel.startsWith('/')) {
    return { ok: false, error: 'Target must be relative' };
  }
  for (const part of targetRel.split('/').filter((p) => p.length > 0)) {
    if (part === '..' || part === '.') {
      return { ok: false, error: 'Path traversal not allowed' };
    }
    if (part.startsWith('.')) {
      return { ok: false, error: 'Hidden path components not allowed' };
    }
  }
  return { ok: true };
}

function resolveRestoreTarget(
  folderPath: string,
  originalPath: string | null,
  assetFolderId: ObjectId,
  opts: RestoreAssetOptions,
): RestoreTargetResolution {
  const guarded = crossLibraryGuard(assetFolderId, opts);
  if (guarded) return guarded;

  if (typeof opts.targetRelativePath !== 'string' || opts.targetRelativePath.length === 0) {
    if (!originalPath) {
      return { kind: 'error', error: 'Asset has no original_path; supply targetRelativePath' };
    }
    return { kind: 'ok', targetAbs: originalPath };
  }

  const shape = validateRestoreRelativePath(opts.targetRelativePath);
  if (!shape.ok) return { kind: 'invalid', error: shape.error };
  return { kind: 'ok', targetAbs: path.join(folderPath, opts.targetRelativePath) };
}

/** Re-stat the restored file: `moveOutOfTrash` may have appended a
 * `.restored[.N]` suffix on collision, so `filename`/`size`/`mtime` must
 * be refreshed to match the new on-disk state. Falls back to the prior
 * doc's `size` (and the current time for `mtimeMs`) on a stat failure —
 * logged, not fatal. */
async function restatRestoredFile(
  newAbsPath: string,
  fallbackSize: number,
): Promise<{ size: number; mtimeMs: number }> {
  try {
    const st = await stat(newAbsPath);
    return { size: st.size, mtimeMs: st.mtimeMs };
  } catch (err) {
    log.warn(
      { absPath: newAbsPath, err: err instanceof Error ? err.message : String(err) },
      'restore: stat of new path failed — using prior doc values',
    );
    return { size: fallbackSize, mtimeMs: Date.now() };
  }
}

/**
 * Restore one trashed asset: move its file back out of trash (via
 * `moveOutOfTrash`, collision-safe via `pickFreeRestoredPath`), repoint its
 * fileinfo entry and clear `deleted_at` (via `restoreFromTrash`), and
 * emit a restore change.
 * Mirrors `POST /api/assets/:id/restore` exactly.
 */
export async function restoreAssetById(
  id: ObjectId,
  opts: RestoreAssetOptions = {},
): Promise<RestoreAssetOutcome> {
  const info = await findCoreInfoById(id);
  if (!info) return { kind: 'not-found' };
  if (!info.deleted_at) return { kind: 'not-trashed' };

  // A reaped row (#2977) has no trashed file copy — the original vanished
  // from disk outside Maple. There is nothing to move back; the row revives
  // automatically if the content reappears (discover dedup).
  if (info.deleted_reason === 'reaped') {
    return {
      kind: 'error',
      error: 'File was removed from disk — there is no trashed copy to restore',
    };
  }

  // Only the copy the trash action moved into `.maple/trash/` ever moves back
  // (#5405); an untouched copy elsewhere stays where it is.
  const source = await resolveRestoreSource(info.fileinfo, opts.entry);
  if ('kind' in source) return source;
  const { location, libraryRoot, absPath: trashedAbsPath } = source;
  const entrySpec: AssetLocationEntry = {
    libraryId: location.library_id,
    path: location.path,
    filename: location.filename,
  };
  const assetFolderId = entrySpec.libraryId;

  const targetResolution = resolveRestoreTarget(
    libraryRoot,
    info.original_path,
    assetFolderId,
    opts,
  );
  if (targetResolution.kind !== 'ok') return targetResolution;
  const destinationRefusal = await restoreDestinationRefusal(
    libraryRoot,
    targetResolution.targetAbs,
  );
  if (destinationRefusal) return destinationRefusal;

  const intent = await prepareLifecycle(
    id.toHexString(),
    'restore',
    assetFolderId.toHexString(),
    path.relative(libraryRoot, trashedAbsPath).split(path.sep).join('/'),
  );
  const result = await runLifecycleMove(intent, () =>
    moveOutOfTrash(
      trashedAbsPath,
      targetResolution.targetAbs,
      (target) => recordLifecycleTarget(intent, libraryRoot, trashedAbsPath, target),
      () => fenceLifecycleMove(intent),
      async (target) => {
        const { size, mtimeMs } = await restatRestoredFile(target, info.size);
        await restoreFromTrash({
          id,
          libraryRoot,
          libraryId: assetFolderId,
          newAbsPath: target,
          size,
          mtimeMs,
          source: entrySpec,
          lifecycle: await lifecycleCommit(intent),
        });
      },
      (candidate) =>
        restoreBackupDestinationOccupied(
          id,
          assetFolderId,
          path.relative(libraryRoot, candidate).split(path.sep).join('/'),
        ),
    ),
  );
  if (result.kind !== 'ok') {
    await finishLocalLifecycle(intent, true);
    return { kind: 'error', error: result.error };
  }

  const restoredFilename = path.basename(result.newAbsPath);
  const { size: restoredSize, mtimeMs: restoredMtimeMs } = await restatRestoredFile(
    result.newAbsPath,
    info.size,
  );
  await finishLocalLifecycle(intent);

  // `folder_id` MUST be the library the restored entry belongs to
  // (`assetFolderId`, resolved above from `opts.entry` or the asset's
  // folder) — not `info.folder_id` (the asset's globally-primary
  // library), for the same reason the trash-side change event uses
  // `libraryId` instead (#2695 review).
  await recordAndPublishAssetChange({
    kind: 'restore',
    asset_id: id,
    folder_id: assetFolderId,
    abs_path: result.newAbsPath,
  }).catch(() => {});

  return {
    kind: 'ok',
    assetId: id,
    folderId: assetFolderId,
    absPath: result.newAbsPath,
    filename: restoredFilename,
    size: restoredSize,
    mtimeMs: restoredMtimeMs,
  };
}
