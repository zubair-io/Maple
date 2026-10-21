/**
 * Relocate's last step in move mode: settle each carried sidecar and remove
 * the companions, then the original photo, which stays when an old-name edit
 * of it is still beside it (#5063).
 */
import { hasLegacyBackupEdit } from './legacy-backup-sidecar.ts';
import * as fs from './mirrored.ts';
import type { MovedSidecar } from './relocate-sidecar-plan.ts';
import { settleCarriedSidecar } from './sidecar-ownership.ts';
import { child as childLogger } from '../log.ts';

const log = childLogger('fs/relocate');

/** Step 6, move mode only: delete the original primary + every sidecar that
 * was actually copied (one left in place on a copy failure keeps its
 * original, per `tryCopySidecar`'s best-effort contract). Best-effort —
 * a failure here leaves a harmless duplicate on disk, the accepted failure
 * direction, never data loss, so it's logged rather than thrown. */
export async function deleteOriginals(
  sourceAbsPath: string,
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
  const leaseHeld = await (beforeSourceDelete?.() ?? Promise.resolve()).then(
    () => true,
    (err: unknown) => {
      log.warn(
        { sourceAbsPath, err: err instanceof Error ? err.message : err },
        'relocate: source delete no longer allowed — the original is kept',
      );
      return false;
    },
  );
  if (leaseHeld) await removeSourcePrimary(sourceAbsPath);
}

/** Last, so an old-name edit left behind for any reason keeps its photo, the
 * only place the migration looks for it (#5063). */
async function removeSourcePrimary(sourceAbsPath: string): Promise<void> {
  if (await hasLegacyBackupEdit(sourceAbsPath)) {
    log.error(
      { sourceAbsPath },
      'relocate: an old-name backup edit stayed at the old path — the original is kept with it',
    );
    return;
  }
  await fs.unlink(sourceAbsPath).catch((err) => {
    log.warn(
      { sourceAbsPath, err: err instanceof Error ? err.message : err },
      'relocate: source primary unlink failed after a verified copy — a duplicate is left on disk (acceptable failure direction, never data loss)',
    );
  });
}
