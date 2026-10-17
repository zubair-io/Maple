/**
 * Shared-sidecar ownership rule (#4692) — see docs/xmp-canonical-format.md
 * § "Moving, renaming and trashing a photo". A `<stem>.xmp` belongs to every
 * primary with that stem in its folder (`IMG_1.CR3` + `IMG_1.JPG` share
 * `IMG_1.xmp`), so file operations must never treat it as exclusively the
 * moving photo's:
 *
 *   1. A source sidecar still claimed by a live sibling primary is copied,
 *      never moved or trashed.
 *   2. An occupied destination sidecar is a collision for the whole asset.
 *   3. Identical source and target sidecar paths are left alone.
 *   4. Sidecars publish exclusively, and the snapshot + source unlink run
 *      inside the same per-sidecar save barrier the XMP writers use.
 */
import * as fs from './mirrored.ts';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import { listPairedSidecars } from './xmp-conflict.ts';
import { serializeSidecarWrite } from './sidecar-write-order.ts';
import { isVideoFilename } from '../indexer/media-types';
import { child as childLogger } from '../log.ts';

const log = childLogger('fs/sidecar-ownership');

export class SidecarCollisionError extends Error {
  constructor(readonly destination: string) {
    super(`relocate: destination sidecar is occupied: ${destination}`);
    this.name = 'SidecarCollisionError';
  }
}

function comparable(p: string): string {
  return path.resolve(p).normalize('NFC').toLowerCase();
}

export function sameSidecarPath(a: string, b: string): boolean {
  return comparable(a) === comparable(b);
}

/** Rule 3 asks whether two names are one file. A case-only difference is the
 * same file only where the filesystem folds case (APFS, NTFS), not on ext4. */
export async function sameSidecarFile(a: string, b: string): Promise<boolean> {
  if (path.resolve(a) === path.resolve(b)) return true;
  if (!sameSidecarPath(a, b)) return false;
  const [sa, sb] = await Promise.all([fs.stat(a).catch(() => null), fs.stat(b).catch(() => null)]);
  return sa !== null && sb !== null && sa.dev === sb.dev && sa.ino === sb.ino;
}

function stemOf(filename: string): string {
  return path
    .basename(filename, isVideoFilename(filename) ? '' : path.extname(filename))
    .normalize('NFC')
    .toLowerCase();
}

/** True when a file in `primaryAbsPath`'s folder, other than the primary and
 * `excluded` (files leaving with it), shares its sidecar stem. An unlistable
 * folder counts as claimed. Over-inclusive on purpose: a false positive leaves a harmless duplicate sidecar behind, a
 * false negative carries away another photo's edits. */
export async function sidecarStemClaimedBySibling(
  primaryAbsPath: string,
  excluded: readonly string[] = [],
): Promise<boolean> {
  const dir = path.dirname(primaryAbsPath);
  const skip = new Set([primaryAbsPath, ...excluded].map(comparable));
  const stem = stemOf(primaryAbsPath);
  const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => null);
  if (entries === null) return true;
  return entries.some(
    (entry) =>
      !entry.isDirectory() &&
      !entry.name.startsWith('.') &&
      !entry.name.includes('.tmp.') &&
      path.extname(entry.name).toLowerCase() !== '.xmp' &&
      !skip.has(comparable(path.join(dir, entry.name))) &&
      stemOf(entry.name) === stem,
  );
}

/** Destination occupancy for a whole asset: the primary path itself, or any
 * sidecar paired to it that is not one of the moving asset's own sidecars. */
export async function assetDestinationOccupied(
  candidate: string,
  ownSidecars: readonly string[],
): Promise<boolean> {
  try {
    await fs.lstat(candidate);
    return true;
  } catch {
    const paired = await listPairedSidecars(candidate);
    return paired.some((sidecar) => !ownSidecars.some((own) => sameSidecarPath(own, sidecar)));
  }
}

async function linkExclusive(tmp: string, dest: string): Promise<void> {
  try {
    await fs.link(tmp, dest);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code === 'EEXIST') throw new SidecarCollisionError(dest);
    if (code !== 'ENOTSUP' && code !== 'EPERM' && code !== 'EXDEV') throw err;
    try {
      await fs.copyFile(tmp, dest, fs.constants.COPYFILE_EXCL);
    } catch (copyErr) {
      if ((copyErr as NodeJS.ErrnoException)?.code === 'EEXIST') {
        throw new SidecarCollisionError(dest);
      }
      throw copyErr;
    }
  }
}

async function writeVerifiedTemp(dest: string, bytes: Buffer): Promise<string> {
  const tmp = `${dest}.tmp.${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
  await fs.writeFile(tmp, bytes);
  if (!bytes.equals(await fs.readFile(tmp))) {
    await fs.unlink(tmp).catch(() => {});
    throw new Error(`relocate: sidecar copy verification failed: ${dest}`);
  }
  return tmp;
}

/** Read `source` inside its save barrier and publish those bytes at `dest`
 * without ever replacing an occupant. Returns the snapshot so the later
 * source unlink can tell whether a save landed in between. */
export async function publishSidecarSnapshot(source: string, dest: string): Promise<Buffer> {
  return serializeSidecarWrite(source, async () => {
    const snapshot = await fs.readFile(source);
    const tmp = await writeVerifiedTemp(dest, snapshot);
    try {
      await linkExclusive(tmp, dest);
    } finally {
      await fs.unlink(tmp).catch(() => {});
    }
    return snapshot;
  });
}

/** Settle a carried sidecar's source inside its save barrier. A save that
 * landed after the snapshot is carried to `dest` when `dest` still holds the
 * snapshot. The source is then removed unless a sibling still claims it
 * (`keepSource`); when both ends changed it is kept so neither save is lost. */
export async function settleCarriedSidecar(
  source: string,
  dest: string,
  snapshot: Buffer,
  keepSource: boolean,
): Promise<void> {
  await serializeSidecarWrite(source, async () => {
    const current = await fs.readFile(source).catch(() => null);
    if (current === null) return;
    if (!current.equals(snapshot)) {
      const carried = await serializeSidecarWrite(dest, async () => {
        const atDest = await fs.readFile(dest).catch(() => null);
        if (atDest === null || !atDest.equals(snapshot)) return false;
        const tmp = await writeVerifiedTemp(dest, current);
        await fs.rename(tmp, dest);
        return true;
      });
      if (!carried) {
        log.warn(
          { source, dest },
          'relocate: sidecar changed at both ends during the move — source kept so neither save is lost',
        );
        return;
      }
    }
    if (!keepSource) await fs.unlink(source);
  });
}
