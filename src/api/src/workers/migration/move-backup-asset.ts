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
 *      folder (`finalize`).
 *
 * The DB write sits BETWEEN verify and delete: a crash after it leaves the row
 * pointing at the good new file (old lingers as a harmless orphan); a crash
 * before it leaves the row on the still-present old file. Either way no photo
 * is lost — see `restructure-fs.ts` for the full ordering rationale.
 *
 * There used to be a fourth step, collapsing a duplicate live `fileinfo` entry
 * that a concurrent discover sweep may have added for the new path mid-move.
 * It has no counterpart after the SQLite cutover (#3787): a location is a row
 * under a UNIQUE `(library_id, path, filename)` index, so the second entry
 * cannot be created and there is nothing to collapse.
 *
 * When `newDir === oldDir` there is nothing to move; the caller's done-marker
 * (if any) is still stamped, so a migration can record that it has evaluated
 * the asset without relocating the file.
 *
 * Mirror replication: every filesystem op here is delegated to `restructure-fs.ts`
 * (`planAndPlace`/`finalize`/`revertCreated`), which imports the mirror-aware
 * drop-in `fs/mirrored.ts`. So a relocation's copy/unlink/rmdir fan out to the
 * library's configured backup mirror(s) automatically — there is no raw
 * `node:fs` write in this module to swap.
 */

import type { FileInfo } from '../../db/schema.ts';
import type { MigrationCandidate, MigrationMarker } from '../../db/repos/assets.migrations.ts';
import { repointBackupLocation, stampMarkerIfUnmoved } from '../../db/repos/assets.refile.ts';
import { child as childLogger } from '../../log.ts';
import { finalize, planAndPlace, revertCreated } from './restructure-fs.ts';

/**
 * Return the primary active file info for an asset (ignoring missing_since).
 */
function assetActiveFileInfo(asset: Pick<MigrationCandidate, 'fileinfo'>): FileInfo | null {
  for (const entry of asset.fileinfo) {
    if (!entry.deleted_at) return entry;
  }
  return null;
}

const log = childLogger('migration:move');

export type MoveOutcome =
  | 'moved' // file (and companions) relocated + row repointed
  | 'noop' // already in place; the marker stamped if one was supplied
  | 'skipped'; // nothing to do, or a concurrent change reverted the attempt

/** The done-marker a caller stamps as part of the move. */
export interface MoveMarker {
  name: MigrationMarker;
  version: number;
}

/**
 * Relocate the asset's canonical file (its first non-deleted location) into
 * `newDir`, repointing the row between verify and delete. `marker` is stamped
 * by the repoint write and, in the `newDir === oldDir` case, on its own.
 *
 * Throws `SourceMissingError` (re-exported from `restructure-fs.ts`) when the
 * source original is gone — the caller skips rather than counting a hard error.
 */
export async function moveBackupAsset(
  doc: MigrationCandidate,
  libRoot: string,
  newDir: string,
  marker?: MoveMarker,
): Promise<MoveOutcome> {
  // Canonical entry = first live location, not blindly the one at ordinal 0
  // (which may be a delete-then-readd tombstone) (#1519).
  const primary = assetActiveFileInfo(doc);
  if (!primary) return 'skipped';
  const oldDir = primary.path;

  // Already where it belongs — stamp the marker (if any) and bail without
  // touching the filesystem. The stamp is gated on the canonical location still
  // being where we read it, the same guard the relocation path uses. If a
  // concurrent operation moved it between our read and now, the asset may no
  // longer be "already in place", so stamping it done would be wrong — and the
  // marker would then permanently exclude it. On a mismatch we skip (leave it
  // unstamped) so a later tick re-evaluates from the current state.
  if (newDir === oldDir) {
    if (!marker) return 'skipped';
    const stamped = await stampMarkerIfUnmoved(doc.id, primary, marker.name, marker.version);
    return stamped ? 'noop' : 'skipped';
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

  // 2. Repoint the row to the new location (between verify and delete). The old
  //    location and its liveness are in the write's own `WHERE`, so a `false`
  //    means it no longer existed — a concurrent operation moved or removed it
  //    between our read and this write, and we must NOT delete the source.
  const lastSlash = plan.newRelPath.lastIndexOf('/');
  const newPath = lastSlash === -1 ? '' : plan.newRelPath.slice(0, lastSlash);
  const newFilename = lastSlash === -1 ? plan.newRelPath : plan.newRelPath.slice(lastSlash + 1);
  const repointed = await repointBackupLocation(
    doc.id,
    primary,
    { path: newPath, filename: newFilename },
    plan.newRenderedRel,
    marker,
  );

  if (!repointed) {
    // The location changed under us — the repoint didn't apply. Roll back the
    // copies we made (the source + row are still consistent) and skip; a later
    // pass re-attempts from the current state. Crucially, we never reach
    // finalize/delete on this path.
    await revertCreated(plan.createdPaths);
    log.warn(
      { _id: String(doc.id) },
      'move: fileinfo entry changed concurrently — reverted copy, left original + row intact',
    );
    return 'skipped';
  }

  if (plan.outcome === 'deduped') {
    log.info(
      { _id: String(doc.id), maple_id: doc.maple_id },
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
  return 'moved';
}
