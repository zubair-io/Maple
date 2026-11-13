/** Retiring a photo's pre-#5021 old-name backup sidecar once a send lands (#5021). */
import { createHash } from 'node:crypto';
import type { ObjectId } from '../db/object-id.ts';
import {
  hasSidecarDivergence,
  recordSidecarDivergence,
} from '../db/repos/sidecar-divergences.repo.ts';
import {
  claimedByAnotherFile,
  legacyBackupSidecar,
  readLegacyAt,
} from '../fs/legacy-backup-sidecar.ts';
import { readSidecarBytes } from '../fs/sidecar-bytes.ts';
import { errnoCode } from '../fs/relocate-publish.ts';
import * as fs from '../fs/mirrored.ts';

const sha256 = (xmp: string): string => createHash('sha256').update(xmp, 'utf8').digest('hex');

/** Unlink `legacy` only if no other file claims it yet and it still holds `expected`. */
export async function removeLegacyIfUnchanged(
  primary: string,
  legacy: string,
  expected: Buffer,
): Promise<void> {
  if (await claimedByAnotherFile(primary, legacy)) return;
  const current = await readSidecarBytes(legacy).catch(() => null);
  if (!current?.equals(expected)) return;
  // The other process (route or migration) may have removed it first.
  await fs.unlink(legacy).catch((err: unknown) => {
    if (errnoCode(err) !== 'ENOENT') throw err;
  });
}

export interface LandedBackupSidecar {
  primary: string;
  xmp: string;
  assetId: ObjectId;
  libraryId: ObjectId;
  sidecarRelPath: string;
  deviceId: string;
}

/** A failure fails the send, so the device retries instead of leaving a stale file to replay. */
export async function retireLegacyBackupSidecar(landed: LandedBackupSidecar): Promise<void> {
  const legacy = legacyBackupSidecar(landed.primary);
  const bytes = legacy ? await readLegacyAt(landed.primary, legacy) : null;
  if (!legacy || !bytes) return;
  const legacyXmp = bytes.toString('utf8');
  const kept = {
    assetId: landed.assetId,
    libraryId: landed.libraryId,
    sidecarRelPath: landed.sidecarRelPath,
    displacedSha256: sha256(legacyXmp),
    incomingSha256: sha256(landed.xmp),
  };
  // Keyed on the displaced version alone, as the migration's own record is.
  if (
    legacyXmp !== landed.xmp &&
    !(await hasSidecarDivergence({ ...kept, incomingSha256: undefined }))
  ) {
    await recordSidecarDivergence({
      ...kept,
      deviceId: landed.deviceId,
      baseSha256: null,
      displacedXmp: legacyXmp,
    });
  }
  await removeLegacyIfUnchanged(landed.primary, legacy, bytes);
}
