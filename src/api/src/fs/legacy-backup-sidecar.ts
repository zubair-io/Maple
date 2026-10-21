/**
 * The pre-#5021 backup sidecar name: the photo's full file name plus `.xmp`
 * (`IMG_1234.HEIC.xmp`), which the server never reads. Videos are excluded,
 * since their canonical sidecar already has that name. Movers carry it with
 * the photo (#5063) until the canonical-backup-sidecars migration renames it.
 */
import path from 'node:path';
import { isVideoFilename } from '../indexer/media-types.ts';
import * as fs from './mirrored.ts';
import { readSidecarBytes, SidecarNotRegularFileError } from './sidecar-bytes.ts';
import { errnoCode } from './relocate-publish.ts';
import { child as childLogger } from '../log.ts';

const log = childLogger('fs/legacy-backup-sidecar');

/** Only Maple writes these namespaces (current, legacy and early bindings),
 * so another tool's `<name>.<ext>.xmp` is never touched. */
const MAPLE_XMP_NAMESPACE = /ns\.justmaple\.app\/|maple\.app\/(?:ns|xmp)\/1\.0\//;

/** `xmpSidecarPath`'s rule on a bare name, which this module can't import without a cycle through `xmp-conflict`. */
function canonicalSidecarName(name: string): string {
  if (isVideoFilename(name)) return `${name}.xmp`;
  const ext = path.extname(name);
  return `${name.slice(0, name.length - ext.length)}.xmp`;
}

export function legacyBackupSidecar(primary: string): string | null {
  return path.extname(primary) === '' || isVideoFilename(primary) ? null : `${primary}.xmp`;
}

const folded = (name: string): string => name.normalize('NFC').toLowerCase();

/** True when `sidecar` is named as `primary`'s old-name file. It names one
 * photo's full file name, so it is never shared with a same-stem sibling. */
export function isLegacyBackupSidecarOf(primary: string, sidecar: string): boolean {
  const legacy = legacyBackupSidecar(primary);
  return legacy !== null && folded(path.basename(sidecar)) === folded(path.basename(legacy));
}

/** Another entry of the folder whose own sidecar is named `legacy`
 * (`IMG.HEIC.JPG` owns `IMG.HEIC.xmp`). Names only, so a symlinked root can't hide it. */
function ownedByAnotherEntry(primary: string, legacy: string, entries: readonly string[]): boolean {
  const self = path.basename(primary).normalize('NFC');
  const target = folded(path.basename(legacy));
  return entries.some(
    (name) =>
      name.normalize('NFC') !== self &&
      path.extname(name).toLowerCase() !== '.xmp' &&
      folded(canonicalSidecarName(name)) === target,
  );
}

/** An unlistable folder counts as claimed. */
export async function claimedByAnotherFile(
  primary: string,
  legacy: string,
  listed?: readonly string[],
): Promise<boolean> {
  const entries = listed ?? (await fs.readdir(path.dirname(primary)).catch(() => null));
  return entries === null || ownedByAnotherEntry(primary, legacy, entries);
}

/** The Maple edit in `legacy`; `null` when absent, another file's, another tool's, or not a regular file. */
export async function readLegacyAt(
  primary: string,
  legacy: string,
  listed?: readonly string[],
): Promise<Buffer | null> {
  try {
    const bytes = await readSidecarBytes(legacy);
    if (!bytes || !MAPLE_XMP_NAMESPACE.test(bytes.toString('utf8'))) return null;
    return (await claimedByAnotherFile(primary, legacy, listed)) ? null : bytes;
  } catch (err) {
    if (err instanceof SidecarNotRegularFileError) return null;
    throw err;
  }
}

/** An unreadable old-name file counts as an edit, so it is never written past or landed on. */
export async function hasLegacyBackupEdit(primary: string): Promise<boolean> {
  // Case-aware, as the migration finds it; a folder that can't be listed counts.
  const edit = await locateLegacyBackupEdit(primary).catch(() => 'unreadable');
  return edit !== null;
}

/** An old-name file that exists but can't be read, or whose folder can't be
 * listed to rule out another owner. Every case variant counts; a name too long
 * to hold one, a link, or a folder that's gone means there is no such file. */
export async function oldNameEditUnreadable(primary: string): Promise<boolean> {
  const legacy = legacyBackupSidecar(primary);
  if (legacy === null) return false;
  const listed = await fs
    .readdir(path.dirname(primary))
    .catch((err: unknown) => (errnoCode(err) === 'ENOENT' ? [] : null));
  if (listed === null) return exactEditPresent(legacy);
  for (const entry of legacyEntries(legacy, listed)) {
    const unreadable = await readSidecarBytes(path.join(path.dirname(primary), entry)).then(
      () => false,
      (err: unknown) => !(err instanceof SidecarNotRegularFileError),
    );
    if (unreadable) return true;
  }
  return false;
}

/** With the folder unlistable, only the exact name can be probed: a Maple edit
 * there, or a file there that can't be read, can't be ruled out as the photo's. */
async function exactEditPresent(legacy: string): Promise<boolean> {
  const bytes = await readSidecarBytes(legacy).catch((err: unknown) =>
    err instanceof SidecarNotRegularFileError ? null : ('unreadable' as const),
  );
  if (bytes === 'unreadable') {
    return fs.lstat(legacy).then(
      () => true,
      () => false,
    );
  }
  return bytes !== null && MAPLE_XMP_NAMESPACE.test(bytes.toString('utf8'));
}

/** The lenient listing drops an old-name edit it can't read; a mover that
 * went ahead would leave it behind with no photo, so it refuses instead. */
export async function oldNameEditUnlisted(
  primary: string,
  listed: readonly string[],
): Promise<boolean> {
  if (listed.some((sidecar) => isLegacyBackupSidecarOf(primary, sidecar))) return false;
  return oldNameEditUnreadable(primary);
}

/** Whether an old-name edit carried to `primary` can't land: something is at
 * that name, or another file there owns it. A folder that doesn't exist yet is
 * free, and a name with no such slot (no extension) leaves the edit behind. */
export async function oldNameSlotTaken(primary: string): Promise<boolean> {
  const legacy = legacyBackupSidecar(primary);
  if (legacy === null) return false;
  const present = await fs.lstat(legacy).then(
    () => true,
    () => false,
  );
  if (present) return true;
  const entries = await fs.readdir(path.dirname(primary)).catch((err: unknown) => {
    if (errnoCode(err) === 'ENOENT') return [];
    return null;
  });
  return (
    entries === null ||
    legacyEntries(legacy, entries).length > 0 ||
    ownedByAnotherEntry(primary, legacy, entries)
  );
}

/** The listed entries named as `primary`'s old-name file: the exact name first,
 * then each case variant whose own photo isn't there (a case-sensitive volume
 * keeps both). An unrelated file at one spelling never hides another. */
function legacyEntries(legacy: string, listed: readonly string[]): string[] {
  const exact = path.basename(legacy).normalize('NFC');
  const present = new Set(listed.map((name) => name.normalize('NFC')));
  const variants = listed.filter((name) => {
    const nfc = name.normalize('NFC');
    const photo = nfc.slice(0, -'.xmp'.length);
    return nfc !== exact && folded(nfc) === folded(exact) && !present.has(photo);
  });
  // Every stored spelling: a volume that keeps NFC and NFD apart can hold both,
  // and another tool's file at one never hides a Maple edit at the other.
  const byteExact = path.basename(legacy);
  const ownName = byteExact.slice(0, -'.xmp'.length);
  const stored = new Set(listed);
  // A normalization-sensitive volume can hold both spellings of the photo too;
  // each spelling's edit then belongs to its own byte-spelled photo.
  const ownPhoto = stored.has(ownName)
    ? ownName
    : listed.find((name) => name.normalize('NFC') === ownName.normalize('NFC'));
  const exactMatches = listed
    .filter((name) => name.normalize('NFC') === exact)
    .filter((name) => {
      const itsPhoto = name.slice(0, -'.xmp'.length);
      return itsPhoto === ownPhoto || !stored.has(itsPhoto);
    })
    .sort((a, b) => Number(b === byteExact) - Number(a === byteExact));
  return [...exactMatches, ...variants];
}

/** `primary`'s old-name edit as stored, case variant included. Throws when its
 * folder exists but can't be listed, so a caller retries rather than reading
 * "no edit"; a folder that's gone holds none. */
export async function locateLegacyBackupEdit(
  primary: string,
  skip: ReadonlySet<string> = new Set(),
): Promise<{ legacy: string; bytes: Buffer } | null> {
  const listed = await fs.readdir(path.dirname(primary)).catch((err: unknown) => {
    if (errnoCode(err) === 'ENOENT') return null;
    throw err;
  });
  if (listed === null) return null;
  const legacy = await pairedLegacyBackupSidecar(primary, listed, skip);
  if (legacy === null) return null;
  const bytes = await readLegacyAt(primary, legacy, listed);
  return bytes === null ? null : { legacy, bytes };
}

/** The old-name file among `listed` (the primary's folder) that travels with
 * `primary`. Throws when it can't be read, so a strict caller never leaves it behind. */
export async function pairedLegacyBackupSidecar(
  primary: string,
  listed: readonly string[],
  skip: ReadonlySet<string> = new Set(),
): Promise<string | null> {
  const legacy = legacyBackupSidecar(primary);
  if (legacy === null) return null;
  for (const entry of legacyEntries(legacy, listed)) {
    const stored = path.join(path.dirname(primary), entry);
    if (skip.has(stored)) continue;
    if ((await readLegacyAt(primary, stored, listed)) !== null) return stored;
  }
  return null;
}

/** A mover's last step: remove the original photo, unless an old-name edit of
 * it is still beside it, the only place the migration looks for that edit
 * (#5063). Keeping it leaves a duplicate rather than a disconnected edit. */
export async function removePhotoUnlessOldNameEditStays(
  primary: string,
  mover: string,
): Promise<void> {
  if (await hasLegacyBackupEdit(primary)) {
    log.error(
      { primary, mover },
      'an old-name backup edit stayed beside the original — photo kept',
    );
    return;
  }
  await fs.unlink(primary).catch((err: unknown) => {
    log.warn(
      { primary, mover, err: err instanceof Error ? err.message : err },
      'original photo unlink failed after a verified copy — duplicate kept',
    );
  });
}
