/**
 * The pre-#5021 backup sidecar name: the photo's full file name plus `.xmp`
 * (`IMG_1234.HEIC.xmp`), which the server never reads. Videos are excluded,
 * since their canonical sidecar already has that name.
 */
import { createHash } from 'node:crypto';
import path from 'node:path';
import type { ObjectId } from '../db/object-id.ts';
import {
  hasSidecarDivergence,
  recordSidecarDivergence,
} from '../db/repos/sidecar-divergences.repo.ts';
import { readSidecarBytes, SidecarNotRegularFileError } from '../fs/sidecar-ownership.ts';
import { errnoCode } from '../fs/relocate-publish.ts';
import { xmpSidecarPath } from '../fs/xmp.ts';
import * as fs from '../fs/mirrored.ts';

/** Only Maple writes these namespaces (current, legacy and early bindings),
 * so another tool's `<name>.<ext>.xmp` is never touched. */
const MAPLE_XMP_NAMESPACE = /ns\.justmaple\.app\/|maple\.app\/(?:ns|xmp)\/1\.0\//;

const sha256 = (xmp: string): string => createHash('sha256').update(xmp, 'utf8').digest('hex');

export function legacyBackupSidecar(primary: string): string | null {
  if (path.extname(primary) === '') return null;
  const legacy = `${primary}.xmp`;
  return path.resolve(xmpSidecarPath(primary)) === path.resolve(legacy) ? null : legacy;
}

const comparable = (p: string): string => path.resolve(p).normalize('NFC').toLowerCase();

/** `IMG.HEIC.JPG`'s own sidecar is also named `IMG.HEIC.xmp`; an unlistable folder counts as claimed. */
async function claimedByAnotherFile(primary: string, legacy: string): Promise<boolean> {
  const dir = path.dirname(primary);
  const entries = await fs.readdir(dir).catch(() => null);
  if (entries === null) return true;
  return entries.some(
    (name) =>
      comparable(path.join(dir, name)) !== comparable(primary) &&
      path.extname(name).toLowerCase() !== '.xmp' &&
      comparable(xmpSidecarPath(path.join(dir, name))) === comparable(legacy),
  );
}

/** The Maple edit in `legacy`; `null` when absent, another file's, another tool's, or not a regular file. */
async function readLegacyAt(primary: string, legacy: string): Promise<Buffer | null> {
  if (await claimedByAnotherFile(primary, legacy)) return null;
  try {
    const bytes = await readSidecarBytes(legacy);
    return bytes && MAPLE_XMP_NAMESPACE.test(bytes.toString('utf8')) ? bytes : null;
  } catch (err) {
    if (err instanceof SidecarNotRegularFileError) return null;
    throw err;
  }
}

/** `primary`'s pre-#5021 Maple edit, if it has one. */
export async function readLegacyBackupEdit(primary: string): Promise<Buffer | null> {
  const legacy = legacyBackupSidecar(primary);
  return legacy === null ? null : readLegacyAt(primary, legacy);
}

/** An unreadable old-name file counts as an edit, so it is never written past. */
export async function hasLegacyBackupEdit(primary: string): Promise<boolean> {
  const edit = await readLegacyBackupEdit(primary).catch(() => 'unreadable');
  return edit !== null;
}

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
