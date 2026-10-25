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
 */

import { appleCompanionPaths } from '../db/apple-companions.ts';
import type { ObjectId } from '../db/object-id.ts';
import { recordAndPublishAssetChange } from '../db/repos/changes.repo.ts';
import { keepSurvivingCopy } from '../db/repos/assets.trash-survivor.ts';
import { inventoryFolderPurges } from '../cloud-backup/folder-purge-inventory.ts';
import { BackupRepository } from '../cloud-backup/repository.ts';
import { capturedTrashPurge } from '../cloud-backup/trash-purge-admission.ts';
import { refusesFileUnderMarker } from '../fs/mapleignore-guard.ts';
import { unlinkPrimaryForPurge } from '../fs/mirrored.ts';
import { errnoCode } from '../fs/relocate-publish.ts';
import { resolvePurgeCompanions } from './purge-rendered-companion.ts';
import {
  unlinkTrashedCopy,
  type CopyAddress,
  type PurgeFailureSink,
  type TrashedCopy,
} from './trashed-copy.ts';

export type SurvivorPurgeOutcome =
  | { kind: 'kept'; survivor: CopyAddress; errors: number }
  | { kind: 'changed' }
  | { kind: 'retry'; error: unknown }
  | { kind: 'full-purge' };

type PurgeInfo = Parameters<typeof capturedTrashPurge>[0];

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

async function unlinkCompanion(target: string, onFailure: PurgeFailureSink): Promise<boolean> {
  try {
    if (!(await refusesFileUnderMarker(target))) await unlinkPrimaryForPurge(target);
    return true;
  } catch (error) {
    if (errnoCode(error) === 'ENOENT') return true;
    onFailure(target, error);
    return false;
  }
}

async function unlinkCompanions(
  targets: readonly string[],
  onFailure: PurgeFailureSink,
): Promise<number> {
  const results = await Promise.all(targets.map((target) => unlinkCompanion(target, onFailure)));
  return results.filter((ok) => !ok).length;
}

export async function purgeKeepingSurvivor(
  id: ObjectId,
  info: PurgeInfo,
  copy: TrashedCopy,
  onFailure: PurgeFailureSink,
): Promise<SurvivorPurgeOutcome> {
  const survivor = copy.survivor;
  if (survivor === null) return { kind: 'full-purge' };
  const dropCompanions = companionsLeaveWithTrashedCopy(info, copy, survivor);
  const trashed = {
    libraryId: copy.location.library_id,
    path: copy.location.path,
    filename: copy.location.filename,
  };
  const prepared = await Promise.all([
    inventoryFolderPurges(id.toHexString(), new BackupRepository(), {
      libraryId: trashed.libraryId.toHexString(),
      relativePath: trashed.path === '' ? trashed.filename : `${trashed.path}/${trashed.filename}`,
      withCompanions: dropCompanions,
    }),
    dropCompanions ? resolvePurgeCompanions(copy.libraryRoot, info, copy.absPath) : [],
  ]).catch((error: unknown) => ({ error }));
  if ('error' in prepared) return { kind: 'retry', error: prepared.error };

  const outcome = await keepSurvivingCopy({
    id,
    trashed,
    expected: capturedTrashPurge(info),
    dropCompanions,
  });
  if (outcome === 'purge-in-flight') return { kind: 'full-purge' };
  if (outcome === 'changed') return { kind: 'changed' };
  const errors =
    (await unlinkTrashedCopy(copy, onFailure)) + (await unlinkCompanions(prepared[1], onFailure));
  await recordAndPublishAssetChange({
    kind: 'restore',
    asset_id: id,
    folder_id: survivor.libraryId,
    abs_path: survivor.absPath,
  });
  return { kind: 'kept', survivor, errors };
}
