/**
 * Shared crash-safe per-asset move for the `refile-backups` backup folder-layout
 * cleanup (and the `restructure-backup-*` migrations it replaced).
 *
 * Given a target directory the asset's canonical file should live in, this:
 *   1. copies the file + companions into the new dir and VERIFIES each
 *      (`planAndPlace`, in `restructure-fs.ts`),
 *   2. repoints the matched `fileinfo` entry to its new (path, filename) and
 *      resets the `thumb`/`preview` cache stage versions (so the workers
 *      regenerate the dropped `.maple` cache at the new path),
 *   3. deletes the sources, drops the stale cache, and reclaims the empty old
 *      folder (`finalize`),
 *   4. collapses any duplicate live `fileinfo` entry a discover-watcher race
 *      may have added mid-move.
 *
 * The DB write sits BETWEEN verify and delete: a crash after it leaves the row
 * pointing at the good new file (old lingers as a harmless orphan); a crash
 * before it leaves the row on the still-present old file. Either way no photo
 * is lost — see `restructure-fs.ts` for the full ordering rationale.
 *
 * When `newDir === oldDir` there is nothing to move; `extraSet` (if any) is
 * still applied so the caller can stamp an idempotency marker (the geo
 * migration's `backup_layout_version`) without relocating the file.
 *
 * Mirror replication: every filesystem op here is delegated to `restructure-fs.ts`
 * (`planAndPlace`/`finalize`/`revertCreated`), which imports the mirror-aware
 * drop-in `fs/mirrored.ts`. So a relocation's copy/unlink/rmdir fan out to the
 * library's configured backup mirror(s) automatically — there is no raw
 * `node:fs` write in this module to swap.
 */

import type { Collection, WithId } from 'mongodb';
import type { AssetDoc, FileInfo } from '../../db/schema.ts';
import { child as childLogger } from '../../log.ts';
import { assetPrimaryFileInfo, updateLiveLocationCount } from '../../indexer/images.repo.ts';
import { finalize, planAndPlace, revertCreated } from './restructure-fs.ts';

/**
 * Return the primary active file info for an asset (ignoring missing_since).
 */
function assetActiveFileInfo(asset: Pick<AssetDoc, 'fileinfo'>): FileInfo | null {
  const list = asset.fileinfo;
  if (!list || list.length === 0) return null;
  for (const entry of list) {
    if (!entry.deleted_at) return entry;
  }
  return null;
}

const log = childLogger('migration:move');

/** Cache-writing stages keyed on the asset's path. Reset to v0 after a move so
 * the workers regenerate the dropped `.maple` cache at the new location. */
const CACHE_STAGES = ['thumb', 'preview'] as const;

export type MoveOutcome =
  | 'moved' // file (and companions) relocated + row repointed
  | 'noop' // already in place; `extraSet` stamped if provided
  | 'skipped'; // nothing to do, or a concurrent change reverted the attempt

/** Build the surgical `$set` that repoints the matched fileinfo entry (the
 * positional `$` from the query's `$elemMatch`) to its new (path, filename),
 * resets the cache stages, and merges any caller-supplied fields. Updating only
 * the matched element preserves a multi-location asset's other entries. */
function buildRepointSet(args: {
  newPath: string;
  newFilename: string;
  newRenderedRel: string | null;
  extraSet?: Record<string, unknown>;
}): Record<string, unknown> {
  const set: Record<string, unknown> = {
    'fileinfo.$.path': args.newPath,
    'fileinfo.$.filename': args.newFilename,
    'fileinfo.$.missing_since': null,
    apple_rendered_path: args.newRenderedRel,
  };
  for (const stage of CACHE_STAGES) {
    set[`stages.${stage}.version`] = 0;
    set[`stages.${stage}.attempts`] = 0;
    set[`stages.${stage}.last_error`] = null;
    set[`stages.${stage}.dead`] = false;
  }
  if (args.extraSet) Object.assign(set, args.extraSet);
  return set;
}

/** `$elemMatch` for the asset's canonical LIVE entry (the one
 * `assetPrimaryFileInfo` returns). The `deleted_at`/`missing_since` null tags are
 * load-bearing: a delete-then-readd doc has a soft-deleted tombstone sharing the
 * live entry's (library_id, path, filename), so without them the positional `$`
 * would repoint the tombstone and `finalize` would delete the live file's source
 * (#1519). Matches the liveness definition in `isLiveFileInfo`. */
function liveEntryElemMatch(primary: FileInfo): Record<string, unknown> {
  return {
    $elemMatch: {
      library_id: primary.library_id,
      path: primary.path,
      filename: primary.filename,
      deleted_at: null,
    },
  };
}

/** Collapse exact-duplicate LIVE fileinfo entries (same library_id/path/
 * filename), keeping the first. A no-op when there are none. Covers the
 * discover-watcher race where `add(new)` lands a second entry before our
 * repoint. */
export async function dedupeLiveFileinfo(
  coll: Collection<AssetDoc>,
  id: WithId<AssetDoc>['_id'],
): Promise<void> {
  const fresh = await coll.findOne({ _id: id }, { projection: { fileinfo: 1 } });
  const list = fresh?.fileinfo;
  if (!list || list.length < 2) return;
  const seen = new Set<string>();
  const deduped: FileInfo[] = [];
  for (const fi of list) {
    const key = `${fi.library_id.toHexString()}|${fi.path}|${fi.filename}|${fi.deleted_at ?? ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(fi);
  }
  if (deduped.length !== list.length) {
    await coll.updateOne({ _id: id }, { $set: { fileinfo: deduped } });
    // Recompute live count: the fileinfo array was collapsed. A race-inserted
    // duplicate live entry would have double-counted; correcting it here keeps
    // live_location_count in sync with the actual array (#1302).
    await updateLiveLocationCount(coll, id);
    log.info(
      { _id: String(id), removed: list.length - deduped.length },
      'move: collapsed duplicate fileinfo entries (discover-watcher race)',
    );
  }
}

/**
 * Relocate the asset's canonical file (its first live `fileinfo` entry, via
 * `assetPrimaryFileInfo`) into `newDir`, repointing the row between verify and
 * delete. `extraSet` is merged into the repoint
 * write and, in the `newDir === oldDir` case, written on its own.
 *
 * Throws `SourceMissingError` (re-exported from `restructure-fs.ts`) when the
 * source original is gone — the caller skips rather than counting a hard error.
 */
export async function moveBackupAsset(
  coll: Collection<AssetDoc>,
  doc: WithId<AssetDoc>,
  libRoot: string,
  newDir: string,
  extraSet?: Record<string, unknown>,
): Promise<MoveOutcome> {
  // Canonical entry = first LIVE fileinfo, not blindly `fileinfo[0]` (which may be
  // a delete-then-readd tombstone). `assetPrimaryFileInfo` already filters to live,
  // so no separate `deleted_at` guard is needed (#1519).
  const primary = assetActiveFileInfo(doc);
  if (!primary) return 'skipped';
  const oldDir = primary.path;

  // Already where it belongs — stamp the marker (if any) and bail without
  // touching the filesystem. Gate the stamp on the canonical entry still being
  // where we read it: the SAME `$elemMatch` the relocation path uses. If a
  // concurrent op moved `fileinfo[0]` between our read and now, the asset may no
  // longer be "already in place", so stamping it done would be wrong — and in
  // the geo migration `backup_layout_version` would permanently exclude it. On
  // a mismatch we skip (leave it unstamped) so a later tick re-evaluates from
  // the current state.
  if (newDir === oldDir) {
    if (extraSet && Object.keys(extraSet).length > 0) {
      const res = await coll.updateOne(
        {
          _id: doc._id,
          fileinfo: liveEntryElemMatch(primary),
        },
        { $set: extraSet },
      );
      return res.matchedCount === 0 ? 'skipped' : 'noop';
    }
    return 'skipped';
  }

  // 1. Copy + verify the file and its companions into the new dir. Sources are
  //    NOT deleted yet.
  const plan = await planAndPlace({
    libRoot,
    oldDir,
    filename: primary.filename,
    newDir,
    renderedRelOld: doc.apple_rendered_path ?? null,
  });

  // 2. Repoint the DB to the new location (between verify and delete). The
  //    fileinfo entry is matched in the QUERY ($elemMatch) so `matchedCount`
  //    tells us whether it still existed — if a concurrent op moved or removed
  //    it between our read and this write, the repoint is a no-op and we must
  //    NOT delete the source. The positional `$` then updates exactly that
  //    matched element, preserving any sibling entries.
  const lastSlash = plan.newRelPath.lastIndexOf('/');
  const newPath = lastSlash === -1 ? '' : plan.newRelPath.slice(0, lastSlash);
  const newFilename = lastSlash === -1 ? plan.newRelPath : plan.newRelPath.slice(lastSlash + 1);
  const res = await coll.updateOne(
    {
      _id: doc._id,
      fileinfo: liveEntryElemMatch(primary),
    },
    {
      $set: buildRepointSet({
        newPath,
        newFilename,
        newRenderedRel: plan.newRenderedRel,
        extraSet,
      }),
    } as never,
  );

  if (res.matchedCount === 0) {
    // The entry changed under us — the repoint didn't apply. Roll back the
    // copies we made (the source + row are still consistent) and skip; a later
    // pass re-attempts from the current state. Crucially, we never reach
    // finalize/delete on this path.
    await revertCreated(plan.createdPaths);
    log.warn(
      { _id: String(doc._id) },
      'move: fileinfo entry changed concurrently — reverted copy, left original + row intact',
    );
    return 'skipped';
  }

  if (plan.outcome === 'deduped') {
    log.info(
      { _id: String(doc._id), maple_id: doc.maple_id },
      'move: deduped against an existing byte-identical copy at the new path',
    );
  }

  // 3. Delete sources, drop stale cache, reclaim the empty old folder.
  await finalize({
    libRoot,
    oldDirAbs: plan.oldDirAbs,
    mapleId: doc.maple_id,
    filename: primary.filename,
    sourcesToDelete: plan.sourcesToDelete,
  });

  // 4. Reconcile any duplicate fileinfo entry the discover watcher may have
  //    added for the new path mid-move.
  await dedupeLiveFileinfo(coll, doc._id);
  return 'moved';
}
