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
import { listPairedSidecars, pickFreeConflictPath } from './xmp-conflict.ts';
import { sidecarRenameTarget } from './sidecar-rename.ts';
import {
  serializeSidecarWrite,
  serializeSidecarWrites,
  trySerializeSidecarWrite,
} from './sidecar-write-order.ts';
import { isCataloguedFilename, isVideoFilename } from '../indexer/media-types';
import { readSidecarBytes } from './sidecar-bytes.ts';
import { isLegacyBackupSidecarOf, oldNameSlotTaken } from './legacy-backup-sidecar.ts';
import { child as childLogger } from '../log.ts';
import {
  PublishCollisionError,
  errnoCode,
  publishExclusive,
  type RelocatePublication,
} from './relocate-publish.ts';
import { DISPLACED_MARKER, privateSiblingOf, VERIFYING_COPY_MARKER } from './private-sibling.ts';

const log = childLogger('fs/sidecar-ownership');

export class SidecarCollisionError extends PublishCollisionError {
  constructor(destination: string) {
    super(destination, `relocate: destination sidecar is occupied: ${destination}`);
    this.name = 'SidecarCollisionError';
  }
}

/** The temp names relocate, restore and the XMP writers stage under —
 * `<name>.tmp.<pid>-<hex>[.copy|.keep]` or `<name>.tmp.<pid>.<hex>`. A real photo whose
 * name merely contains `.tmp.` (`IMG.tmp.JPG`) still claims its stem. */
const STAGING_NAME = /\.tmp\.\d+[-.][0-9a-f]+(\.copy|\.keep)?$/;

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
      !STAGING_NAME.test(entry.name) &&
      path.extname(entry.name).toLowerCase() !== '.xmp' &&
      !skip.has(exact(path.join(dir, entry.name))) &&
      stemOf(entry.name) === stem,
  );
}

/** The positive answer a caller needs before removing a photo and leaving its
 * sidecar to another: a distinct regular media file in the folder shares the
 * stem. Extensionless regular files may be media and retain ownership.
 * Symlinks and non-media extensions never count (#4694), nor does the primary's own entry under another spelling; a
 * separately named hard link does. A folder or sibling that can't be read
 * throws, so it is never taken as "owned elsewhere" (#5069). */
export async function sidecarStemOwnedByAnotherFile(primaryAbsPath: string): Promise<boolean> {
  const dir = path.dirname(primaryAbsPath);
  const stem = stemOf(primaryAbsPath);
  const primaryName = path.basename(primaryAbsPath).normalize('NFC').toLowerCase();
  const self = await lstatUnlessGone(primaryAbsPath);
  const candidates = (await fs.readdir(dir, { withFileTypes: true })).filter(
    (entry) =>
      !entry.isDirectory() &&
      !entry.isSymbolicLink() &&
      !entry.name.startsWith('.') &&
      !STAGING_NAME.test(entry.name) &&
      (isCataloguedFilename(entry.name) ||
        isVideoFilename(entry.name) ||
        path.extname(entry.name) === '') &&
      stemOf(entry.name) === stem,
  );
  const distinct = await Array.fromAsync(candidates, async (entry) => {
    const other = await lstatUnlessGone(path.join(dir, entry.name));
    if (other === null || !other.isFile()) return false;
    const primaryEntry =
      self !== null &&
      entry.name.normalize('NFC').toLowerCase() === primaryName &&
      other.dev === self.dev &&
      other.ino === self.ino;
    return !primaryEntry;
  });
  return distinct.some(Boolean);
}

async function lstatUnlessGone(target: string) {
  return fs.lstat(target).catch((err: NodeJS.ErrnoException) => {
    if (err.code === 'ENOENT') return null;
    throw err;
  });
}

/** The photo's own sidecar that would land on `sidecar`; same-file aware, so a
 * case-folding volume matches `IMG.xmp` to an existing `img.xmp`. */
export async function incomingSidecarFor(
  sourceAbsPath: string,
  candidate: string,
  ownSidecars: readonly string[],
  sidecar: string,
): Promise<string | undefined> {
  for (const own of ownSidecars) {
    const target = sidecarRenameTarget(sourceAbsPath, candidate, own);
    if (target !== null && (await sameSidecarFile(target, sidecar))) return own;
  }
  return undefined;
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

export async function requireSidecarBytes(sidecar: string): Promise<Buffer> {
  const bytes = await readSidecarBytes(sidecar);
  if (bytes === null) throw new Error(`relocate: sidecar vanished: ${sidecar}`);
  return bytes;
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
        ? await incomingSidecarFor(sourceAbsPath, candidate, ownSidecars, sidecar)
        : undefined;
      if (incoming && (await sidecarAlreadyCarried(incoming, sidecar))) continue;
      return true;
    }
    return (
      sourceAbsPath !== undefined &&
      oldNameSlotBlocked(candidate, ownSidecars, paired, sourceAbsPath)
    );
  }
}

/** A carried old-name edit (#5063) can't land where the listing sees nothing
 * but something sits, or another file there owns the name. */
async function oldNameSlotBlocked(
  candidate: string,
  ownSidecars: readonly string[],
  paired: readonly string[],
  sourceAbsPath: string,
): Promise<boolean> {
  if (!ownSidecars.some((own) => isLegacyBackupSidecarOf(sourceAbsPath, own))) return false;
  const target = path.resolve(`${candidate}.xmp`);
  if (paired.some((listed) => path.resolve(listed) === target)) return false;
  return oldNameSlotTaken(candidate);
}

async function linkExclusive(tmp: string, dest: string): Promise<RelocatePublication> {
  try {
    return await publishExclusive(tmp, dest);
  } catch (err) {
    throw err instanceof PublishCollisionError ? new SidecarCollisionError(dest) : err;
  }
}

export async function writeVerifiedTemp(dest: string, bytes: Buffer): Promise<string> {
  const tmp = privateSiblingOf(dest, VERIFYING_COPY_MARKER);
  try {
    await fs.writeFile(tmp, bytes);
    if (!bytes.equals(await fs.readFile(tmp))) {
      throw new Error(`relocate: sidecar copy verification failed: ${dest}`);
    }
    return tmp;
  } catch (err) {
    await fs.unlink(tmp).catch(() => {});
    throw err;
  }
}

/** Join an identical sidecar already at `dest`: snapshot `source` and confirm
 * `dest` still matches, under both save barriers. A save that changed `dest`
 * turns the join back into a collision. */
export async function joinCarriedSidecar(source: string, dest: string): Promise<Buffer> {
  return serializeSidecarWrites([source, dest], async () => {
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
 * (`keepSource`); when both ends changed it is kept so neither save is lost. `primary` is the
 * photo the sidecar now belongs to, which names any conflict copy. */
export async function settleCarriedSidecar(
  source: string,
  dest: string,
  snapshot: Buffer,
  keepSource: boolean,
  primary: string,
): Promise<void> {
  await serializeSidecarWrites([source, dest], async () => {
    const current = await readSidecarBytes(source);
    if (current === null) return;
    if (!current.equals(snapshot) && !(await carryLateSave(current, dest, snapshot, primary))) {
      log.warn(
        { source, dest },
        'relocate: sidecar changed at both ends during the move — source kept so neither save is lost',
      );
      return;
    }
    if (!keepSource) await fs.unlink(source);
  });
}

async function carryLateSave(
  current: Buffer,
  dest: string,
  snapshot: Buffer,
  primary: string,
): Promise<boolean> {
  const atDest = await readSidecarBytes(dest);
  if (atDest === null || !atDest.equals(snapshot)) return false;
  const tmp = await writeVerifiedTemp(dest, current);
  try {
    return await replaceIfHolds(dest, snapshot, tmp, async (aside, moved) => {
      if (moved === null || !(await publishConflictBytes(primary, moved)))
        throw new Error(
          `conflict copy could not be published; moved-aside sidecar kept at ${aside}`,
        );
      await fs.unlink(aside);
    });
  } finally {
    await fs.unlink(tmp).catch(() => {});
  }
}

/** Replaces `dest` with the staged `tmp` only if `dest` still holds `snapshot`. The save barrier
 * is process-local, so another process can save to `dest` after a check: `dest` is moved aside
 * first and the moved file is what is compared. Anything else is put back (`putBack` takes the
 * aside file and its bytes when a writer took `dest` meanwhile) and false is returned. A failure
 * leaves the aside file in place rather than lose it. */
export async function replaceIfHolds(
  dest: string,
  snapshot: Buffer,
  tmp: string,
  putBack: (aside: string, moved: Buffer | null) => Promise<void>,
): Promise<boolean> {
  const aside = privateSiblingOf(dest, DISPLACED_MARKER);
  const movedAside = await fs.rename(dest, aside).then(
    () => true,
    (err: unknown) => {
      if (errnoCode(err) === 'ENOENT') return false;
      throw err;
    },
  );
  if (!movedAside) return false;
  const moved = await readSidecarBytes(aside).catch(() => null);
  const restore = async (bytes: Buffer | null): Promise<void> => {
    await publishExclusive(aside, dest)
      .catch((err: unknown) => {
        if (!(err instanceof PublishCollisionError)) throw err;
        return putBack(aside, bytes);
      })
      .catch((err: unknown) => {
        log.error({ aside, dest, err: String(err) }, 'a sidecar moved aside could not be put back');
        throw err;
      });
    await fs.unlink(aside).catch(() => {});
  };
  if (!moved?.equals(snapshot)) {
    await restore(moved);
    return false;
  }
  const published = await publishExclusive(tmp, dest).then(
    () => true,
    async (err: unknown) => {
      if (err instanceof PublishCollisionError) return false;
      await restore(moved);
      throw err;
    },
  );
  await fs.unlink(aside).catch(() => {});
  return published;
}

/** Publish `bytes` at `dest` exclusively, through a verified temp. */
export async function publishBytesExclusive(
  dest: string,
  bytes: Buffer,
  publications?: RelocatePublication[],
): Promise<void> {
  const tmp = await writeVerifiedTemp(dest, bytes);
  try {
    const publication = await publishExclusive(tmp, dest);
    publications?.push(publication);
  } finally {
    await fs.unlink(tmp).catch(() => {});
  }
}

const CONFLICT_ATTEMPTS = 5;

/** `bytes` as a `(conflict from move)` copy beside `photo`, which the
 * migration never adopts; another writer can take the picked name first, so
 * it picks again. False when no copy could be published. */
export async function publishConflictBytes(
  photo: string,
  bytes: Buffer,
  publications?: RelocatePublication[],
): Promise<boolean> {
  for (let attempt = 0; attempt < CONFLICT_ATTEMPTS; attempt++) {
    const conflict = await pickFreeConflictPath(photo, 'move');
    const published = await trySerializeSidecarWrite(conflict, () =>
      publishBytesExclusive(conflict, bytes, publications),
    ).then(
      (result) => result.acquired,
      () => false,
    );
    if (published) return true;
  }
  return false;
}

/** Moves `source` to a conflict copy beside `photo`, read, copied and removed under one
 * barrier so a save in between is never left behind. The bytes left at `source` when no copy
 * could be published; `null` when nothing is stranded. */
export async function carryAsConflictCopy(source: string, photo: string): Promise<Buffer | null> {
  return serializeSidecarWrite(source, async () => {
    const bytes = await readSidecarBytes(source).catch(() => null);
    if (bytes === null) return null;
    if (!(await publishConflictBytes(photo, bytes))) return bytes;
    // Another process can still save without this barrier; such a save stays.
    const now = await readSidecarBytes(source).catch(() => null);
    if (now?.equals(bytes)) await fs.unlink(source).catch(() => {});
    return null;
  });
}
