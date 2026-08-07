/**
 * Recursive folder trash + restore (#2630) — built entirely on the
 * single-asset orchestration in `library/asset-trash.ts`, which is itself
 * built on the generic crash-safe `relocateFile` primitive
 * (`fs/relocate.ts`, #2629). Trashing a folder finds every live asset whose
 * fileinfo entry sits under the target subtree and trashes each one
 * individually — every file lands at its own `.maple/trash/<rel>`
 * (`computeTrashPath` in `fs/trash.ts` is purely per-file, so the trash
 * destinations naturally mirror the source tree's relative structure with
 * no extra bookkeeping). Restore reverses it by finding every trashed
 * asset whose recorded `original_path` was under that subtree and
 * restoring each one back to its own `original_path`, which reconstructs
 * the tree for the same reason.
 *
 * Partial-failure semantics: this is a per-asset batch, not a single
 * transaction. One asset failing to move does NOT roll back the assets
 * that already succeeded (matches the file-management design doc's
 * "Batch operations" contract and the existing batch-metadata editor) —
 * the caller gets a summary of exactly which assets moved and which
 * didn't.
 *
 * 30-day auto-purge: no new GC needed. `workers/trash-gc.ts` sweeps by the
 * asset doc's top-level `deleted_at` field alone — it has no notion of
 * "folder" at all — so every asset this module trashes (via the same
 * `markSoftDeleted` used by the single-asset route) is automatically
 * covered by the existing sweep the moment `deleted_at` is stamped.
 */

import * as path from 'node:path';
import type { ObjectId } from 'mongodb';
// `readdir` is read-only, `rmdir` is the mirror-aware write — both routed
// through `fs/mirrored.ts` (which re-exports the full `node:fs/promises`
// surface) rather than a direct `node:fs/promises` import, per the oxlint
// fs-import guardrail.
import { readdir, rmdir } from '../fs/mirrored.ts';
import { assetsCollection } from '../db/client.ts';
import type { AssetWithId, FileInfo } from '../db/schema.ts';
import { trashAssetById, restoreAssetById } from './asset-trash.ts';
import { child as childLogger } from '../log.ts';

const log = childLogger('library/folder-trash');

export interface FolderBatchItemResult {
  assetId: string;
  filename: string;
  ok: boolean;
  error?: string;
}

export interface FolderBatchSummary {
  total: number;
  succeeded: number;
  failed: number;
  items: FolderBatchItemResult[];
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** True when `entryPath` (a fileinfo entry's directory, relative to its
 * library root) is `relPath` itself or a descendant of it. Shared shape
 * between the Mongo query below and the in-memory entry pick per matched
 * doc — `^relPath(/|$)` matches `relPath` exactly (the `$` branch) or any
 * `relPath/...` descendant (the `/` branch) without false-matching a
 * sibling whose name merely starts with the same characters (e.g.
 * `photos` must not match `photos2`). */
function underRelPath(entryPath: string, relPath: string): boolean {
  return entryPath === relPath || entryPath.startsWith(relPath + '/');
}

/** Find the fileinfo entry (if any) that makes `doc` live under
 * `(folderId, relPath)` — the entry the Mongo query below matched on. */
function pickFolderEntry(
  doc: Pick<AssetWithId, 'fileinfo'>,
  folderId: ObjectId,
  relPath: string,
): FileInfo | null {
  const list = doc.fileinfo ?? [];
  return (
    list.find(
      (e) => e.library_id.equals(folderId) && !e.deleted_at && underRelPath(e.path, relPath),
    ) ?? null
  );
}

/** Every live asset with a fileinfo entry under `(folderId, relPath)`,
 * recursively (the regex's `(/|$)` branch covers arbitrary depth). */
async function findLiveAssetsUnderFolder(
  folderId: ObjectId,
  relPath: string,
): Promise<AssetWithId[]> {
  const coll = await assetsCollection();
  const pathRegex = new RegExp(`^${escapeRegExp(relPath)}(/|$)`);
  return coll
    .find({
      fileinfo: {
        $elemMatch: {
          library_id: folderId,
          deleted_at: null,
          path: { $regex: pathRegex },
        },
      },
      // Live filter — mirrors `db/migrations.ts`'s legacy-tolerant "not
      // trashed" predicate: live rows write `deleted_at: null` explicitly,
      // but pre-backfill legacy rows may lack the field entirely.
      $or: [{ deleted_at: null }, { deleted_at: { $exists: false } }],
    })
    .toArray();
}

/** Every trashed asset whose recorded `original_path` was under the
 * absolute folder path `folderRoot/relPath`, and that still carries a
 * fileinfo entry for `folderId` (the entry `moveToTrash` repointed). */
async function findTrashedAssetsUnderFolder(
  folderId: ObjectId,
  folderRoot: string,
  relPath: string,
): Promise<AssetWithId[]> {
  const coll = await assetsCollection();
  const absFolderPath = relPath === '' ? folderRoot : path.join(folderRoot, relPath);
  const prefixRegex = new RegExp(`^${escapeRegExp(absFolderPath)}(/|$)`);
  return coll
    .find({
      'fileinfo.library_id': folderId,
      // Mirrors `buildTrashListFilter`'s `$type: 'string'` — required for
      // the `deleted_at_1` partial index to be provably usable by the
      // planner (see that function's doc comment in `routes/folders.ts`).
      deleted_at: { $type: 'string' },
      original_path: { $regex: prefixRegex },
    })
    .toArray();
}

/** Best-effort: remove directories left empty after every asset under them
 * moved to trash, walking bottom-up so a parent only gets a chance once
 * its children are gone. Never removes `stopAt` itself (the trashed
 * folder's own parent boundary is the caller's concern, not this
 * function's). A directory that still holds anything — including an
 * orphaned `.maple/` thumb cache for the files that just moved away — is
 * silently left in place; this is cosmetic cleanup, not a correctness
 * requirement, so any failure (permissions, non-empty, already gone) is
 * swallowed. */
async function removeEmptyDirsBottomUp(dirAbs: string, stopAt: string): Promise<void> {
  let entries;
  try {
    entries = await readdir(dirAbs, { withFileTypes: true });
  } catch {
    return; // already gone, or never existed
  }
  for (const entry of entries) {
    if (entry.isDirectory()) {
      await removeEmptyDirsBottomUp(path.join(dirAbs, entry.name), stopAt);
    }
  }
  if (dirAbs === stopAt) return;
  let remaining: string[];
  try {
    remaining = await readdir(dirAbs);
  } catch {
    return;
  }
  if (remaining.length === 0) {
    try {
      await rmdir(dirAbs);
    } catch (err) {
      log.warn(
        { dirAbs, err: err instanceof Error ? err.message : err },
        'folder-trash: best-effort empty-dir cleanup failed — left in place',
      );
    }
  }
}

/** Shape common to both `TrashAssetOutcome` and `RestoreAssetOutcome` —
 * enough for `recordOutcome` to build one `FolderBatchItemResult` from
 * either without knowing which one it's looking at. */
interface AssetOpOutcome {
  kind: string;
  error?: string;
  filename?: string;
}

/**
 * Append one asset's per-op outcome to `items` as a `FolderBatchItemResult`
 * — the single push/log call both `trashFolderRecursive` and
 * `restoreFolderRecursive` funnel through, so their per-asset bookkeeping
 * (and the partial-failure log line) can't drift apart. `okKinds` lists
 * which `outcome.kind` values count as success for THIS op (trash also
 * treats `'already-trashed'` as success — a race with a concurrent trash of
 * the same asset — restore does not have an equivalent).
 */
function recordOutcome(
  items: FolderBatchItemResult[],
  assetId: ObjectId,
  fallbackFilename: string,
  outcome: AssetOpOutcome,
  okKinds: readonly string[],
  ctx: { folderId: ObjectId; relPath: string; verb: string },
): void {
  const assetIdHex = assetId.toHexString();
  if (okKinds.includes(outcome.kind)) {
    items.push({ assetId: assetIdHex, filename: outcome.filename ?? fallbackFilename, ok: true });
    return;
  }
  const error = outcome.error ?? outcome.kind;
  items.push({ assetId: assetIdHex, filename: fallbackFilename, ok: false, error });
  log.warn(
    { assetId: assetIdHex, folderId: ctx.folderId.toHexString(), relPath: ctx.relPath, error },
    `${ctx.verb}: one asset failed — continuing with the rest (no rollback)`,
  );
}

function summarize(items: FolderBatchItemResult[]): FolderBatchSummary {
  const succeeded = items.filter((i) => i.ok).length;
  return { total: items.length, succeeded, failed: items.length - succeeded, items };
}

/**
 * Drive one asset-op (`trashAssetById` / `restoreAssetById`) over every doc
 * in `docs`, recording each outcome via `recordOutcome`. The single loop
 * `trashFolderRecursive` and `restoreFolderRecursive` both funnel through
 * — they differ only in how they find the doc's relevant fileinfo entry
 * (`findEntry`) and which op + success kinds they run (`runOp`/`okKinds`),
 * which is exactly what's parameterised here.
 */
async function processFolderBatchDocs(
  docs: AssetWithId[],
  findEntry: (doc: AssetWithId) => FileInfo | null,
  runOp: (assetId: ObjectId, entry: FileInfo) => Promise<AssetOpOutcome>,
  okKinds: readonly string[],
  ctx: { folderId: ObjectId; relPath: string; verb: string },
): Promise<FolderBatchItemResult[]> {
  const items: FolderBatchItemResult[] = [];
  for (const doc of docs) {
    const entry = findEntry(doc);
    const filename = entry?.filename ?? doc.fileinfo?.[0]?.filename ?? '';
    if (!entry) {
      // Matched the query but the in-memory re-derivation found nothing —
      // shouldn't happen (same predicate), but fail this one asset rather
      // than throw the whole batch.
      recordOutcome(
        items,
        doc._id,
        filename,
        { kind: 'no-entry', error: 'no matching fileinfo entry' },
        [],
        ctx,
      );
      continue;
    }
    const outcome = await runOp(doc._id, entry);
    recordOutcome(items, doc._id, filename, outcome, okKinds, ctx);
  }
  return items;
}

/**
 * Recursively trash every live asset under `(folderId, relPath)`. Each
 * asset is moved via `trashAssetById` with an explicit `entry` — the
 * fileinfo entry this query matched on, NOT whatever `assetAbsPath` would
 * pick as the asset's globally "primary" location — so a multi-location
 * asset (deduped across libraries) only has the copy under THIS folder
 * affected, never a copy that happens to live elsewhere.
 *
 * `relPath` must be a non-empty, already-jailed relative path — the caller
 * (`routes/folders-trash.ts`) validates it the same way `/mkdir` and
 * `/move` do before calling in.
 */
export async function trashFolderRecursive(
  folderId: ObjectId,
  folderRoot: string,
  relPath: string,
): Promise<FolderBatchSummary> {
  const docs = await findLiveAssetsUnderFolder(folderId, relPath);
  const items = await processFolderBatchDocs(
    docs,
    (doc) => pickFolderEntry(doc, folderId, relPath),
    (assetId, entry) =>
      trashAssetById(assetId, {
        entry: { libraryId: folderId, path: entry.path, filename: entry.filename },
      }),
    ['ok', 'already-trashed'],
    { folderId, relPath, verb: 'folder-trash' },
  );

  // Cosmetic best-effort cleanup — never blocks or fails the operation.
  await removeEmptyDirsBottomUp(path.join(folderRoot, relPath), folderRoot).catch(() => {});

  return summarize(items);
}

/**
 * Recursively restore every trashed asset whose `original_path` was under
 * `(folderId, folderRoot/relPath)`. Each asset restores to its OWN
 * recorded `original_path` (via `restoreAssetById`'s default target),
 * which is what reconstructs the original tree — no folder-level target
 * remapping is attempted, matching the ticket's "restore reverses it"
 * scope. `entry` is passed explicitly for the same multi-location-safety
 * reason `trashFolderRecursive` passes it.
 */
export async function restoreFolderRecursive(
  folderId: ObjectId,
  folderRoot: string,
  relPath: string,
): Promise<FolderBatchSummary> {
  const docs = await findTrashedAssetsUnderFolder(folderId, folderRoot, relPath);
  const items = await processFolderBatchDocs(
    docs,
    (doc) => (doc.fileinfo ?? []).find((e) => e.library_id.equals(folderId)) ?? null,
    (assetId, entry) =>
      restoreAssetById(assetId, {
        entry: { libraryId: folderId, path: entry.path, filename: entry.filename },
      }),
    ['ok'],
    { folderId, relPath, verb: 'folder-restore' },
  );

  return summarize(items);
}
