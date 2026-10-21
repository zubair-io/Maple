/**
 * Relocate's last step in move mode: settle each carried sidecar and remove
 * the companions, then the original photo. An old-name edit still beside it
 * (#5063) follows the photo as a conflict copy first; the original stays only
 * while one can't, since a kept original would bring a trashed photo back (#5075).
 */
import {
  locateLegacyBackupEdit,
  removePhotoUnlessOldNameEditStays,
} from './legacy-backup-sidecar.ts';
import { readSidecarBytes } from './sidecar-bytes.ts';
import { serializeSidecarWrite } from './sidecar-write-order.ts';
import * as fs from './mirrored.ts';
import type { MovedSidecar } from './relocate-sidecar-plan.ts';
import { publishConflictBytes, settleCarriedSidecar } from './sidecar-ownership.ts';
import { child as childLogger } from '../log.ts';

const log = childLogger('fs/relocate');

/** Step 6, move mode only: delete the original primary + every sidecar that
 * was actually copied (one left in place on a copy failure keeps its
 * original, per `tryCopySidecar`'s best-effort contract). Best-effort —
 * a failure here leaves a harmless duplicate on disk, the accepted failure
 * direction, never data loss, so it's logged rather than thrown. */
export async function deleteOriginals(
  sourceAbsPath: string,
  movedTo: string,
  movedSidecars: MovedSidecar[],
  movedCompanionSources: string[],
  beforeSourceDelete?: () => Promise<void>,
): Promise<void> {
  await beforeSourceDelete?.();
  const removals = [
    ...movedSidecars.map((moved) => ({
      src: moved.source,
      remove: () =>
        settleCarriedSidecar(moved.source, moved.dest, moved.snapshot, moved.keepSource),
    })),
    ...movedCompanionSources.map((src) => ({ src, remove: () => fs.unlink(src) })),
  ];
  for (const { src, remove } of removals) {
    await (async () => {
      await beforeSourceDelete?.();
      await remove();
    })().catch((err) => {
      log.warn(
        { src, err: err instanceof Error ? err.message : err },
        'relocate: source sidecar/companion unlink failed after a verified copy',
      );
    });
  }
  // Sidecars have settled, so a lost lease keeps the original; throwing would revert their copies.
  if (!(await leaseStillHeld(sourceAbsPath, beforeSourceDelete))) return;
  await carryLeftoverOldNameEdits(sourceAbsPath, movedTo);
  // Re-checked: carrying a left-behind edit can wait on a save.
  if (!(await leaseStillHeld(sourceAbsPath, beforeSourceDelete))) return;
  await removePhotoUnlessOldNameEditStays(sourceAbsPath, 'relocate');
}

async function leaseStillHeld(
  sourceAbsPath: string,
  beforeSourceDelete?: () => Promise<void>,
): Promise<boolean> {
  return (beforeSourceDelete?.() ?? Promise.resolve()).then(
    () => true,
    (err: unknown) => {
      log.warn(
        { sourceAbsPath, err: err instanceof Error ? err.message : err },
        'relocate: source delete no longer allowed — the original is kept',
      );
      return false;
    },
  );
}

/** Each old-name spelling still at the old path (one that came too late, or a
 * save the settle kept) lands beside the moved photo as a `(conflict from
 * move)` copy, which the migration never adopts, and leaves the old path under
 * its barrier while it still holds the copied bytes. One that can't follow
 * stays, and keeps the original with it. */
async function carryLeftoverOldNameEdits(sourceAbsPath: string, movedTo: string): Promise<void> {
  const handled = new Set<string>();
  for (;;) {
    const leftover = await locateLegacyBackupEdit(sourceAbsPath, handled).catch(() => null);
    if (leftover === null) return;
    handled.add(leftover.legacy);
    await serializeSidecarWrite(leftover.legacy, async () => {
      const bytes = await readSidecarBytes(leftover.legacy);
      if (bytes === null) return;
      if (!(await publishConflictBytes(movedTo, bytes))) {
        log.warn(
          { legacy: leftover.legacy },
          'relocate: no conflict copy for an old-name edit left behind',
        );
        return;
      }
      const now = await readSidecarBytes(leftover.legacy);
      if (now?.equals(bytes)) await fs.unlink(leftover.legacy);
    }).catch((err: unknown) => {
      log.warn(
        { legacy: leftover.legacy, err: err instanceof Error ? err.message : err },
        'relocate: an old-name edit left behind could not follow the photo',
      );
    });
  }
}
