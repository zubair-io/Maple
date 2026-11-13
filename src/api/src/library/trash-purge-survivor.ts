/**
 * The purge branch for a trashed photo that still has another copy (#5403).
 * Both purge surfaces try this first: when it keeps the photo, only the
 * trashed copy, its sidecars and its own backups are erased, and the photo
 * returns to the library through its surviving copy with every other backup
 * intact.
 *
 * Apple companions are recorded relative to the library of the photo's
 * canonical location. They stay with the survivor unless the trashed copy was
 * canonical and the survivor is in another library: then they sit beside the
 * trashed copy's original folder, would resolve against the wrong library
 * once the survivor becomes canonical, and are erased with the trashed copy.
 * They never move between libraries.
 *
 * The files to unlink are recorded as obligations in the same transaction
 * that takes the photo out of Trash, then drained (`local-purge-drain.ts`),
 * so a failed unlink or a crash in between is retried rather than orphaned.
 *
 * A whole-photo purge an earlier attempt recorded does not stop this (#5419):
 * the photo is still kept, and backups whose erasure had already started are
 * logged as lost, to be made again from the surviving copy.
 */

import * as path from 'node:path';
import {
  APPLE_COMPANION_SLOTS,
  appleCompanionPaths,
  type AppleCompanionSlot,
} from '../db/apple-companions.ts';
import { assetLibraryPath } from '../indexer/images.repo.ts';
import { lstat } from '../fs/mirrored.ts';
import type { ObjectId } from '../db/object-id.ts';
import { recordAndPublishAssetChange } from '../db/repos/changes.repo.ts';
import { keepSurvivingCopy } from '../db/repos/assets.trash-survivor.ts';
import type { LocalPurgeTarget } from '../db/repos/local-purge.repo.ts';
import { inventoryFolderPurges } from '../cloud-backup/folder-purge-inventory.ts';
import { BackupRepository } from '../cloud-backup/repository.ts';
import { capturedTrashPurge } from '../cloud-backup/trash-purge-admission.ts';
import { errnoCode } from '../fs/relocate-publish.ts';
import { listPairedSidecarsStrict } from '../fs/xmp-conflict.ts';
import { child as childLogger } from '../log.ts';
import { drainLocalPurges } from './local-purge-drain.ts';
import {
  fileStampOf,
  ownSidecarsOf,
  realLibraryRoot,
  type CopyAddress,
  type TrashedCopy,
} from './trashed-copy.ts';

export type SurvivorPurgeOutcome =
  | { kind: 'kept'; survivor: CopyAddress; pendingCleanup: number }
  | { kind: 'changed' }
  | { kind: 'retry'; error: unknown }
  | { kind: 'full-purge' };

type PurgeInfo = Parameters<typeof capturedTrashPurge>[0];

const log = childLogger('trash-purge-survivor');

function companionsLeaveWithTrashedCopy(
  info: PurgeInfo,
  copy: TrashedCopy,
  survivor: CopyAddress,
): boolean {
  return (
    copy.isPrimary &&
    !survivor.libraryId.equals(copy.location.library_id) &&
    appleCompanionPaths(info).length > 0
  );
}

const posixRelative = (root: string, target: string): string =>
  path.relative(root, target).split(path.sep).join('/');

/** Everything the purge owes the disk: the trashed copy, its sidecars, and
 * the companions when they leave with it. Recorded before any unlink, and
 * only once the library root is confirmed reachable, so a file is taken as
 * already gone only when its volume is actually there. */
async function cleanupTargets(
  info: PurgeInfo,
  copy: TrashedCopy,
  dropCompanions: boolean,
): Promise<LocalPurgeTarget[]> {
  const ownerRelPath = posixRelative(copy.libraryRoot, copy.absPath);
  const sidecars = await ownSidecarsOf(copy.absPath, listPairedSidecarsStrict).catch(
    (error: unknown) => {
      if (errnoCode(error) === 'ENOENT') return [];
      throw error;
    },
  );
  const trashFiles = [copy.absPath, ...sidecars].map((target) => ({
    relPath: posixRelative(copy.libraryRoot, target),
    ownerRelPath,
    kind: 'trash' as const,
  }));
  const companions = dropCompanions
    ? appleCompanionPaths(info).map((relPath) => ({
        relPath,
        ownerRelPath: relPath,
        kind: 'companion' as const,
      }))
    : [];
  const stamped = await Promise.all(
    [...trashFiles, ...companions].map(async (target) => ({
      ...target,
      stamp: await fileStampOf(path.join(copy.libraryRoot, ...target.relPath.split('/'))),
    })),
  );
  return stamped.flatMap((target) =>
    target.stamp === null ? [] : [{ ...target, stamp: target.stamp }],
  );
}

/**
 * Companions that stay with the photo but are already gone from disk: an
 * earlier whole-photo purge attempt erased them before it stopped (#5419).
 * Their recorded paths are cleared, or every backup of the kept photo would
 * fail on the missing file. Only consulted while such a record exists.
 */
async function lostCompanions(
  id: ObjectId,
  info: PurgeInfo,
  libraries: ReadonlyMap<string, string>,
  dropCompanions: boolean,
): Promise<AppleCompanionSlot[]> {
  const root = assetLibraryPath({ fileinfo: info.fileinfo ?? [] }, libraries);
  if (dropCompanions || root === null || appleCompanionPaths(info).length === 0) return [];
  const [record] = await new BackupRepository().db.read<{ recorded: number }>(
    `SELECT EXISTS (SELECT 1 FROM backup_lifecycle WHERE asset_id = ? AND kind = 'purge') AS recorded`,
    [id.toHexString()],
  );
  if (!record?.recorded) return [];
  const reachableRoot = await realLibraryRoot(root);
  const gone = await Promise.all(
    APPLE_COMPANION_SLOTS.map(async (slot) => {
      const relative = info[slot];
      if (!relative) return false;
      return lstat(path.join(reachableRoot, ...relative.split('/'))).then(
        () => false,
        (error: unknown) => {
          if (errnoCode(error) === 'ENOENT') return true;
          throw error;
        },
      );
    }),
  );
  return APPLE_COMPANION_SLOTS.filter((_, index) => gone[index]);
}

export async function purgeKeepingSurvivor(
  id: ObjectId,
  info: PurgeInfo,
  copy: TrashedCopy,
  libraries: ReadonlyMap<string, string>,
): Promise<SurvivorPurgeOutcome> {
  const survivor = copy.survivor;
  if (survivor === null) return { kind: 'full-purge' };
  const dropCompanions = companionsLeaveWithTrashedCopy(info, copy, survivor);
  const trashed = {
    libraryId: copy.location.library_id,
    path: copy.location.path,
    filename: copy.location.filename,
  };
  const prepared = await realLibraryRoot(copy.libraryRoot)
    .then(() =>
      Promise.all([
        inventoryFolderPurges(id.toHexString(), new BackupRepository(), {
          libraryId: trashed.libraryId.toHexString(),
          relativePath:
            trashed.path === '' ? trashed.filename : `${trashed.path}/${trashed.filename}`,
          withCompanions: dropCompanions,
        }),
        cleanupTargets(info, copy, dropCompanions),
        lostCompanions(id, info, libraries, dropCompanions),
      ]),
    )
    .catch((error: unknown) => ({ error }));
  if ('error' in prepared) return { kind: 'retry', error: prepared.error };

  const outcome = await keepSurvivingCopy({
    id,
    trashed,
    expected: capturedTrashPurge(info),
    dropCompanions,
    lostCompanions: prepared[2],
    cleanup: prepared[1],
  });
  if (outcome.kind === 'changed') return { kind: 'changed' };
  if (outcome.erasedBackups > 0)
    log.warn(
      { assetId: id.toHexString(), erasedBackups: outcome.erasedBackups },
      'kept photo lost backups an earlier whole-photo purge had already erased; they are made again from the surviving copy',
    );
  const pending = await drainLocalPurges({ assetId: id.toHexString() }).then(
    (summary) => summary.pending,
    () => 1,
  );
  await recordAndPublishAssetChange({
    kind: 'restore',
    asset_id: id,
    folder_id: survivor.libraryId,
    abs_path: survivor.absPath,
  });
  return { kind: 'kept', survivor, pendingCleanup: pending };
}
