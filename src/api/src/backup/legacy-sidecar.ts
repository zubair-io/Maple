/**
 * The pre-#5021 backup sidecar name: the photo's full file name plus `.xmp`
 * (`IMG_1234.HEIC.xmp`), which the server never reads. Videos are excluded,
 * since their canonical sidecar already has that name.
 */
import { createHash } from 'node:crypto';
import path from 'node:path';
import type { ObjectId } from '../db/object-id.ts';
import { recordSidecarDivergence } from '../db/repos/sidecar-divergences.repo.ts';
import { readSidecarBytes, SidecarNotRegularFileError } from '../fs/sidecar-ownership.ts';
import { xmpSidecarPath } from '../fs/xmp.ts';
import * as fs from '../fs/mirrored.ts';
import { child as childLogger } from '../log.ts';

const log = childLogger('backup-legacy-sidecar');

/** Only Maple writes these namespaces (current, legacy and early bindings),
 * so another tool's `<name>.<ext>.xmp` is never touched. */
const MAPLE_XMP_NAMESPACE = /ns\.justmaple\.app\/|maple\.app\/(?:ns|xmp)\/1\.0\//;

const sha256 = (xmp: string): string => createHash('sha256').update(xmp, 'utf8').digest('hex');

export function legacyBackupSidecar(primary: string): string | null {
  if (path.extname(primary) === '') return null;
  const legacy = `${primary}.xmp`;
  return path.resolve(xmpSidecarPath(primary)) === path.resolve(legacy) ? null : legacy;
}

/** The Maple edit at `legacy`; `null` when absent, another tool's, or not a regular file. */
export async function readLegacyBackupEdit(legacy: string): Promise<Buffer | null> {
  try {
    const bytes = await readSidecarBytes(legacy);
    return bytes && MAPLE_XMP_NAMESPACE.test(bytes.toString('utf8')) ? bytes : null;
  } catch (err) {
    if (err instanceof SidecarNotRegularFileError) return null;
    throw err;
  }
}

/** An unreadable old-name file counts as an edit, so it is never written past. */
export async function hasLegacyBackupEdit(primary: string): Promise<boolean> {
  const legacy = legacyBackupSidecar(primary);
  const edit =
    legacy === null ? null : await readLegacyBackupEdit(legacy).catch(() => 'unreadable');
  return edit !== null;
}

/** Remove `legacy` unless it changed after `expected` was read. Callers hold
 * the canonical sidecar's barrier, which every old-name change runs under. */
export async function removeLegacyIfUnchanged(legacy: string, expected: Buffer): Promise<void> {
  const current = await readSidecarBytes(legacy).catch(() => null);
  if (current?.equals(expected)) await fs.unlink(legacy);
}

export interface LandedBackupSidecar {
  primary: string;
  xmp: string;
  assetId: ObjectId;
  libraryId: ObjectId;
  sidecarRelPath: string;
  deviceId: string;
}

/** A device's send now holds its current edit, which supersedes the old-name
 * file: keep that file's edit aside when it differs, then remove it. Best
 * effort; runs inside the canonical sidecar's barrier. */
export async function retireLegacyBackupSidecar(landed: LandedBackupSidecar): Promise<void> {
  try {
    const legacy = legacyBackupSidecar(landed.primary);
    const bytes = legacy ? await readLegacyBackupEdit(legacy) : null;
    if (!legacy || !bytes) return;
    const legacyXmp = bytes.toString('utf8');
    if (legacyXmp !== landed.xmp) {
      await recordSidecarDivergence({
        assetId: landed.assetId,
        libraryId: landed.libraryId,
        sidecarRelPath: landed.sidecarRelPath,
        deviceId: landed.deviceId,
        baseSha256: null,
        displacedSha256: sha256(legacyXmp),
        displacedXmp: legacyXmp,
        incomingSha256: sha256(landed.xmp),
      });
    }
    await removeLegacyIfUnchanged(legacy, bytes);
  } catch (err) {
    log.warn(
      { sidecarRelPath: landed.sidecarRelPath, err: err instanceof Error ? err.message : err },
      'old-name backup sidecar not retired — left for the canonical-backup-sidecars migration',
    );
  }
}
