/**
 * Single-asset trash + restore orchestration (#2630) — the Mongo+FS
 * workflow shared by the per-asset HTTP routes (`routes/assets/trash.ts`)
 * and the recursive folder-trash orchestrator (`library/folder-trash.ts`).
 *
 * Factored out so folder trash/restore reuses the EXACT soft-delete /
 * restore workflow a single asset uses — the `moveToTrash`/`moveOutOfTrash`
 * file move (itself built on the generic crash-safe `relocateFile`
 * primitive, `fs/relocate.ts`, #2629), the `markSoftDeleted`/
 * `restoreFromTrash` DB repoint, the best-effort Meilisearch
 * tombstone/re-index, and the change-feed emission — rather than
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

import * as path from 'node:path';
// Read-only re-stat of the restored file — routed through `fs/mirrored.ts`
// (which re-exports the full `node:fs/promises` surface) rather than a
// direct `node:fs/promises` import, per the oxlint fs-import guardrail.
import { stat } from '../fs/mirrored.ts';
import type { ObjectId } from 'mongodb';
import { foldersCollection } from '../db/client.ts';
import { moveToTrash, moveOutOfTrash } from '../fs/trash.ts';
import { composeSearchBlob } from '../enrichment/search-blob.ts';
import { classifyMediaType } from '../indexer/media-types.ts';
import { recordAndPublishAssetChange } from '../db/changes.repo.ts';
import { meilisearchClient } from '../enrichment/meilisearch-client.ts';
import { findCoreInfoById, markSoftDeleted, restoreFromTrash } from '../db/assets.repo.ts';
import type { AssetCoreInfo } from '../db/assets.repo.ts';
import type { FileInfo } from '../db/schema.ts';
import { child as childLogger } from '../log.ts';

const log = childLogger('library/asset-trash');

/** Identifies exactly one fileinfo entry: the library it belongs to, plus
 * its `(path, filename)` within that library. The single currency both
 * `trashAssetById` and `restoreAssetById` resolve down to before touching
 * disk or Mongo — see `resolveEntrySpec`. */
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
  const live = (fileinfo ?? []).filter((entry) => !entry.deleted_at);
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
): AssetLocationEntry | null {
  return explicit ?? toEntrySpec(activeFileInfo(fileinfo));
}

/** Best-effort Meilisearch tombstone on trash — mirrors the indexer's
 * `softDelete()` pattern. Mongo is canonical; a failure here must NOT roll
 * back the soft-delete. The caller's `markSoftDeleted` already reset
 * `stages.meili` in the same atomic update that stamped `deleted_at`, so
 * the meili stage's own handler tombstones the document with retry/backoff
 * even when this inline call fails (#2354) — this is a fast-path only. */
async function tombstoneInSearch(assetId: ObjectId, mapleId: string | null): Promise<void> {
  if (!mapleId) return;
  try {
    await meilisearchClient().tombstone(mapleId);
  } catch (err) {
    log.warn(
      {
        assetId: assetId.toHexString(),
        mapleId,
        err: err instanceof Error ? err.message : String(err),
      },
      'meilisearch tombstone on trash failed — Mongo is canonical, search will exclude via deleted_at filter',
    );
  }
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
}

/**
 * Soft-delete one live asset: move its RAW + sidecars into
 * `.maple/trash/<rel>` (via `moveToTrash`), repoint its fileinfo entry and
 * stamp `deleted_at` (via `markSoftDeleted`), best-effort tombstone it in
 * Meilisearch, and emit a delete change for the File Provider extension.
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
  const entrySpec = resolveEntrySpec(info.fileinfo, opts.entry);
  if (!entrySpec) return { kind: 'no-location' };
  const { libraryId, path: entryPath, filename: entryFilename } = entrySpec;

  const folders = await foldersCollection();
  const folder = await folders.findOne({ _id: libraryId });
  if (!folder) return { kind: 'no-folder' };
  const absPathResolved = path.join(folder.path, entryPath, entryFilename);

  const result = await moveToTrash(absPathResolved, folder.path);
  if (result.kind !== 'ok') return { kind: 'error', error: result.error };

  // `source` tells the repo to rewrite ONLY the matched fileinfo entry
  // instead of clobbering the whole array — when the asset has multiple
  // `fileinfo[]` (deduped across libraries) this preserves the non-trashed
  // locations.
  const originalAbsPath = absPathResolved;
  await markSoftDeleted({
    id,
    libraryRoot: folder.path,
    libraryId,
    newAbsPath: result.newAbsPath,
    originalAbsPath,
    source: { libraryId, path: entryPath, filename: entryFilename },
  });

  await tombstoneInSearch(id, info.maple_id);

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
   * Explicit fileinfo entry identifying WHICH trashed location to restore
   * — same rationale as `TrashAssetOptions.entry`. `activeFileInfo`'s
   * live/not-missing-tagged selection can't distinguish the trashed entry
   * from an untouched entry in a different library (a trashed entry's OWN
   * `deleted_at`/`missing_since` stay null — only the doc's top-level
   * `deleted_at` differs), so the folder-restore orchestrator
   * (`library/folder-trash.ts`) always passes this explicitly. Also
   * bypasses the cross-library guard, since the caller already knows the
   * asset's restore-relevant library.
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
  | { kind: 'no-location' }
  | { kind: 'no-folder' }
  | { kind: 'cross-library'; assetFolderId: string }
  | { kind: 'invalid'; error: string }
  | { kind: 'error'; error: string };

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

/** Best-effort Meilisearch re-index — symmetric with `tombstoneInSearch`.
 * `restoreFromTrash` resets `stages.meili` in the same update that clears
 * `deleted_at`, which is the correctness guarantee (#2354); this is a
 * fast-path convenience only. `search_blob` / `hidden` aren't on the typed
 * `AssetCoreInfo` projection (the fields predate that DTO), so they're
 * read through an untyped view here — same pattern `assets.transform.ts`
 * uses for `description_meta`. */
async function reindexRestoredInSearch(
  assetId: ObjectId,
  info: AssetCoreInfo,
  restoredFilename: string,
  assetFolderId: ObjectId,
): Promise<void> {
  if (!info.maple_id) return;
  const rawInfo = info as unknown as { search_blob?: string | null; hidden?: boolean };
  try {
    await meilisearchClient().upsert({
      id: info.maple_id,
      filename: restoredFilename,
      searchBlob:
        rawInfo.search_blob ??
        composeSearchBlob({
          place: info.place,
          description: info.description,
          ocrText: info.ocr_text,
          capturedMonth: info.exif?.captured_month,
        }),
      description: info.description,
      ocrText: info.ocr_text,
      folderId: assetFolderId.toHexString(),
      capturedAt: info.exif?.captured_at ?? null,
      deletedAt: null,
      mediaType: classifyMediaType(restoredFilename),
      hidden: rawInfo.hidden === true,
    });
  } catch (err) {
    log.warn(
      {
        assetId: assetId.toHexString(),
        mapleId: info.maple_id,
        err: err instanceof Error ? err.message : String(err),
      },
      'meilisearch re-index on restore failed — Mongo restored OK, search will lag until next meili stage pass',
    );
  }
}

/**
 * Restore one trashed asset: move its file back out of trash (via
 * `moveOutOfTrash`, collision-safe via `pickFreeRestoredPath`), repoint its
 * fileinfo entry and clear `deleted_at` (via `restoreFromTrash`),
 * best-effort re-index it in Meilisearch, and emit a restore change.
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

  // The ONE entry this call acts on — same rationale as `trashAssetById`.
  const entrySpec = resolveEntrySpec(info.fileinfo, opts.entry);
  if (!entrySpec) return { kind: 'no-location' };
  const assetFolderId = entrySpec.libraryId;

  const folders = await foldersCollection();
  const folder = await folders.findOne({ _id: assetFolderId });
  if (!folder) return { kind: 'no-folder' };
  const trashedAbsPath = path.join(folder.path, entrySpec.path, entrySpec.filename);

  const targetResolution = resolveRestoreTarget(
    folder.path,
    info.original_path,
    assetFolderId,
    opts,
  );
  if (targetResolution.kind !== 'ok') return targetResolution;

  const result = await moveOutOfTrash(trashedAbsPath, targetResolution.targetAbs);
  if (result.kind !== 'ok') return { kind: 'error', error: result.error };

  const restoredFilename = path.basename(result.newAbsPath);
  const { size: restoredSize, mtimeMs: restoredMtimeMs } = await restatRestoredFile(
    result.newAbsPath,
    info.size,
  );

  // The trashed fileinfo entry to repoint — the SAME `entrySpec` every
  // step above already used, so this can't disagree with `trashedAbsPath`
  // or `assetFolderId`.
  await restoreFromTrash({
    id,
    libraryRoot: folder.path,
    libraryId: assetFolderId,
    newAbsPath: result.newAbsPath,
    size: restoredSize,
    mtimeMs: restoredMtimeMs,
    source: {
      libraryId: entrySpec.libraryId,
      path: entrySpec.path,
      filename: entrySpec.filename,
    },
  });

  await reindexRestoredInSearch(id, info, restoredFilename, assetFolderId);

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
