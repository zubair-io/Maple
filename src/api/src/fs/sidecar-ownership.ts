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
import { sidecarRenameTarget } from './sidecar-rename.ts';
import { serializeSidecarWrite } from './sidecar-write-order.ts';
import { isVideoFilename } from '../indexer/media-types';
import { child as childLogger } from '../log.ts';
import {
  PublishCollisionError,
  publishExclusive,
  type RelocatePublication,
} from './relocate-publish.ts';

const log = childLogger('fs/sidecar-ownership');

export class SidecarCollisionError extends PublishCollisionError {
  constructor(destination: string) {
    super(destination, `relocate: destination sidecar is occupied: ${destination}`);
    this.name = 'SidecarCollisionError';
  }
}

function comparable(p: string): string {
  return path.resolve(p).normalize('NFC').toLowerCase();
}

function sameSidecarPath(a: string, b: string): boolean {
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
  const exact = (p: string) => path.resolve(p).normalize('NFC');
  const skip = new Set([primaryAbsPath, ...excluded].map(exact));
  const stem = stemOf(primaryAbsPath);
  const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => null);
  if (entries === null) return true;
  return entries.some(
    (entry) =>
      !entry.isDirectory() &&
      !entry.name.startsWith('.') &&
      !entry.name.includes('.tmp.') &&
      path.extname(entry.name).toLowerCase() !== '.xmp' &&
      !skip.has(exact(path.join(dir, entry.name))) &&
      stemOf(entry.name) === stem,
  );
}

async function isOwnSidecar(ownSidecars: readonly string[], sidecar: string): Promise<boolean> {
  for (const own of ownSidecars) {
    if (await sameSidecarFile(own, sidecar)) return true;
  }
  return false;
}

/** True when `dest` already holds exactly `source`'s bytes — the sidecar an
 * earlier same-stem photo of the same batch carried there. Landing on it
 * neither overwrites nor adopts different edits, so it is not a collision. */
export async function sidecarAlreadyCarried(source: string, dest: string): Promise<boolean> {
  const [a, b] = await Promise.all([readSidecarBytes(source), readSidecarBytes(dest)]).catch(() => [
    null,
    null,
  ]);
  return a !== null && b !== null && a.equals(b);
}

/** Read that refuses a final-component symlink (#4749), so a sidecar link to
 * an original is never copied into a destination `.xmp`. Callers have already
 * jailed the asset's folder; the DB-backed sidecar jail is not consulted here
 * because a refusal would move the photo without its edits. */
async function readSidecarBytes(sidecar: string): Promise<Buffer | null> {
  const handle = await fs
    .open(sidecar, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW)
    .catch((err: unknown) => {
      if (errnoCode(err) === 'ENOENT') return null;
      throw err;
    });
  if (handle === null) return null;
  try {
    return await handle.readFile();
  } finally {
    await handle.close();
  }
}

export async function requireSidecarBytes(sidecar: string): Promise<Buffer> {
  const bytes = await readSidecarBytes(sidecar);
  if (bytes === null) throw new Error(`relocate: sidecar vanished: ${sidecar}`);
  return bytes;
}

/** Both save barriers, always taken in the same order so two operations
 * touching the same pair from opposite ends cannot deadlock. Barrier keys fold
 * case on every host (`sidecar-write-order.ts`), so two names that differ only
 * in case — or two aliases of one file — share a key and take it once rather
 * than wait on themselves. */
async function withSidecarBarriers<T>(a: string, b: string, run: () => Promise<T>): Promise<T> {
  if (sameSidecarPath(a, b) || (await sameSidecarFile(a, b))) return serializeSidecarWrite(a, run);
  const [first, second] = [a, b].sort((x, y) => (comparable(x) < comparable(y) ? -1 : 1));
  return serializeSidecarWrite(first!, () => serializeSidecarWrite(second!, run));
}

/** Destination occupancy for a whole asset: the primary path itself, or any
 * sidecar paired to it that is neither one of the moving asset's own sidecars
 * nor an identical copy of the one that would land there. */
export async function assetDestinationOccupied(
  candidate: string,
  ownSidecars: readonly string[],
  sourceAbsPath?: string,
): Promise<boolean> {
  try {
    await fs.lstat(candidate);
    return true;
  } catch {
    const paired = await listPairedSidecars(candidate);
    for (const sidecar of paired) {
      if (await isOwnSidecar(ownSidecars, sidecar)) continue;
      const incoming = sourceAbsPath
        ? ownSidecars.find((own) => {
            const target = sidecarRenameTarget(sourceAbsPath, candidate, own);
            return target !== null && path.resolve(target) === path.resolve(sidecar);
          })
        : undefined;
      if (incoming && (await sidecarAlreadyCarried(incoming, sidecar))) continue;
      return true;
    }
    return false;
  }
}

async function linkExclusive(tmp: string, dest: string): Promise<RelocatePublication> {
  try {
    return await publishExclusive(tmp, dest);
  } catch (err) {
    throw err instanceof PublishCollisionError ? new SidecarCollisionError(dest) : err;
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

/** Join an identical sidecar already at `dest`: snapshot `source` and confirm
 * `dest` still matches, under both save barriers. A save that changed `dest`
 * turns the join back into a collision. */
export async function joinCarriedSidecar(source: string, dest: string): Promise<Buffer> {
  return withSidecarBarriers(source, dest, async () => {
    const snapshot = await requireSidecarBytes(source);
    if (!snapshot.equals((await readSidecarBytes(dest)) ?? Buffer.alloc(0))) {
      throw new SidecarCollisionError(dest);
    }
    return snapshot;
  });
}

/** Read `source` inside its save barrier and publish those bytes at `dest`
 * without ever replacing an occupant, recording the publication in
 * `publications` for a later rollback. Returns the snapshot so the later
 * source unlink can tell whether a save landed in between. */
export async function publishSidecarSnapshot(
  source: string,
  dest: string,
  publications: RelocatePublication[] = [],
): Promise<Buffer> {
  return serializeSidecarWrite(source, async () => {
    const snapshot = await requireSidecarBytes(source);
    const tmp = await writeVerifiedTemp(dest, snapshot);
    try {
      publications.push(await linkExclusive(tmp, dest));
    } finally {
      await fs.unlink(tmp).catch(() => {});
    }
    return snapshot;
  });
}

/** Settle a carried sidecar's source under both save barriers. A save that
 * landed after the snapshot is carried to `dest` when `dest` still holds the
 * snapshot. The source is then removed unless a sibling still claims it
 * (`keepSource`); when both ends changed it is kept so neither save is lost. */
export async function settleCarriedSidecar(
  source: string,
  dest: string,
  snapshot: Buffer,
  keepSource: boolean,
): Promise<void> {
  await withSidecarBarriers(source, dest, async () => {
    const current = await readSidecarBytes(source);
    if (current === null) return;
    if (!current.equals(snapshot) && !(await carryLateSave(current, dest, snapshot))) {
      log.warn(
        { source, dest },
        'relocate: sidecar changed at both ends during the move — source kept so neither save is lost',
      );
      return;
    }
    if (!keepSource) await fs.unlink(source);
  });
}

async function carryLateSave(current: Buffer, dest: string, snapshot: Buffer): Promise<boolean> {
  const atDest = await readSidecarBytes(dest);
  if (atDest === null || !atDest.equals(snapshot)) return false;
  const tmp = await writeVerifiedTemp(dest, current);
  await fs.rename(tmp, dest);
  return true;
}
