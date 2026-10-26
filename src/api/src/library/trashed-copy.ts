/**
 * The one copy a Trash purge may erase, and the jail every purge unlink of a
 * photo or sidecar runs inside (#5403). Trashing moves exactly one location
 * into `<library>/.maple/trash/<rel>` and repoints that row there, so the
 * trashed copy is found by its address, never by its position in the location
 * list — the first live location can be an untouched original elsewhere.
 */

import * as path from 'node:path';
import { lstat, realpath, unlinkPrimaryForPurge } from '../fs/mirrored.ts';
import { isLegacyBackupSidecarOf } from '../fs/legacy-backup-sidecar.ts';
import { sidecarStemOwnedByAnotherFile } from '../fs/sidecar-ownership.ts';
import { errnoCode } from '../fs/relocate-publish.ts';
import { refusesFileUnderMarker } from '../fs/mapleignore-guard.ts';
import { isWithinRoot } from '../fs/root.ts';
import { listPairedSidecars } from '../fs/xmp-conflict.ts';
import type { AppleCompanionSlot } from '../db/apple-companions.ts';
import type { ObjectId } from '../db/object-id.ts';
import type { AssetDoc, FileInfo } from '../db/schema.ts';
import type { FileStamp } from '../db/repos/local-purge.repo.ts';
import type { LocationSource } from '../db/repos/assets.trash.ts';
import { assetLibraryPath, isLiveFileInfo } from '../indexer/images.repo.ts';
import { resolvePurgeCompanions } from './purge-rendered-companion.ts';

const TRASH_SEGMENTS = ['.maple', 'trash'] as const;
const TRASH_REL_DIR = TRASH_SEGMENTS.join('/');

export function isTrashRelPath(relDir: string): boolean {
  return relDir === TRASH_REL_DIR || relDir.startsWith(`${TRASH_REL_DIR}/`);
}

export interface CopyAddress {
  libraryId: ObjectId;
  /** Null while the copy's library root is not registered in this process. */
  absPath: string | null;
}

export interface TrashedCopy {
  absPath: string;
  libraryRoot: string;
  location: Pick<FileInfo, 'library_id' | 'path' | 'filename'>;
  /** The trashed copy is the photo's lowest-ordinal location, which owns its Apple companions. */
  isPrimary: boolean;
  /** The lowest-ordinal location outside Trash that is neither deleted nor missing. */
  survivor: CopyAddress | null;
}

function absPathIn(
  libraries: ReadonlyMap<string, string>,
  entry: Pick<FileInfo, 'library_id' | 'path' | 'filename'>,
): string | null {
  const root = libraries.get(entry.library_id.toHexString());
  return root ? path.join(root, ...entry.path.split('/'), entry.filename) : null;
}

function survivingCopy(
  live: readonly FileInfo[],
  libraries: ReadonlyMap<string, string>,
): CopyAddress | null {
  const survivor = live.find((entry) => isLiveFileInfo(entry) && !isTrashRelPath(entry.path));
  return survivor
    ? { libraryId: survivor.library_id, absPath: absPathIn(libraries, survivor) }
    : null;
}

/** `fileinfo` is in ordinal order. Null when no live location is inside Trash
 * or its library is unregistered. With `named`, only that location qualifies:
 * a restore or purge the caller pinned to one copy never acts on another. */
export function resolveTrashedCopy(
  fileinfo: readonly FileInfo[] | undefined,
  libraries: ReadonlyMap<string, string>,
  named?: LocationSource,
): TrashedCopy | null {
  const live = (fileinfo ?? []).filter((entry) => !entry.deleted_at);
  const trashed = live.find(
    (entry) =>
      isTrashRelPath(entry.path) &&
      (!named ||
        (entry.library_id.equals(named.libraryId) &&
          entry.path === named.path &&
          entry.filename === named.filename)),
  );
  const libraryRoot = trashed ? libraries.get(trashed.library_id.toHexString()) : undefined;
  if (!trashed || !libraryRoot) return null;
  return {
    absPath: absPathIn(libraries, trashed)!,
    libraryRoot,
    location: trashed,
    isPrimary: fileinfo?.[0] === trashed,
    survivor: survivingCopy(live, libraries),
  };
}

export class OutsideTrashError extends Error {
  constructor(target: string, libraryRoot: string) {
    super(`refusing to purge "${target}": not inside "${libraryRoot}/.maple/trash/"`);
    this.name = 'OutsideTrashError';
  }
}

export class LibraryUnreachableError extends Error {
  constructor(libraryRoot: string, cause: unknown) {
    super(`library root "${libraryRoot}" is unreachable`, { cause });
    this.name = 'LibraryUnreachableError';
  }
}

/**
 * The library root's real path, or `LibraryUnreachableError` while it cannot
 * be resolved (an unmounted or offline volume). Every purge confirms this
 * before treating a missing file as removed, since every file under an
 * unreachable root also looks missing.
 */
export async function realLibraryRoot(libraryRoot: string): Promise<string> {
  try {
    return await realpath(libraryRoot);
  } catch (error) {
    throw new LibraryUnreachableError(libraryRoot, error);
  }
}

export const libraryReachable = (libraryRoot: string): Promise<boolean> =>
  realLibraryRoot(libraryRoot).then(
    () => true,
    () => false,
  );

const isStrictlyInside = (parent: string, child: string): boolean =>
  child !== parent && isWithinRoot(parent, child);

async function realpathOrNull(target: string): Promise<string | null> {
  try {
    return await realpath(target);
  } catch (error) {
    const code = errnoCode(error);
    if (code === 'ENOENT' || code === 'ENOTDIR') return null;
    throw error;
  }
}

/**
 * The canonical path to unlink for `target`, and the jail a restore's source
 * passes before it moves and again before it is removed (#5405): its real
 * directory plus its own name. Throws
 * `OutsideTrashError` unless it lies inside `<libraryRoot>/.maple/trash/`,
 * both as written and with symlinked directories followed, and with
 * `.maple/trash` itself a real directory of the real library root. Null means the directory holding it no longer
 * exists. An unreachable library root throws, so the caller retries rather
 * than mistaking an unmounted volume for a removed file. The last component
 * is never followed, so a symlink there loses only the link.
 */
export async function checkTrashPurgeTarget(
  target: string,
  libraryRoot: string,
): Promise<string | null> {
  const trashRoot = path.resolve(libraryRoot, ...TRASH_SEGMENTS);
  const resolved = path.resolve(target);
  if (!isStrictlyInside(trashRoot, resolved)) throw new OutsideTrashError(target, libraryRoot);
  const realRoot = await realLibraryRoot(libraryRoot);
  const [realTrashRoot, realParent] = await Promise.all([
    realpathOrNull(trashRoot),
    realpathOrNull(path.dirname(resolved)),
  ]);
  if (realTrashRoot === null || realParent === null) return null;
  if (
    realTrashRoot !== path.join(realRoot, ...TRASH_SEGMENTS) ||
    !isWithinRoot(realTrashRoot, realParent)
  ) {
    throw new OutsideTrashError(target, libraryRoot);
  }
  return path.join(realParent, path.basename(resolved));
}

/** A file's identity on disk without following a final symlink, or null when gone. */
export async function fileStampOf(target: string): Promise<FileStamp | null> {
  try {
    const st = await lstat(target, { bigint: true });
    return {
      dev: String(st.dev),
      ino: String(st.ino),
      size: String(st.size),
      mtimeNs: String(st.mtimeNs),
    };
  } catch (error) {
    if (errnoCode(error) === 'ENOENT') return null;
    throw error;
  }
}

/** The trashed copy's own sidecars: a stem it shares with another file keeps
 * the shared XMP, and only the copy's legacy `<name>.<ext>.xmp` goes. */
export async function ownSidecarsOf(
  absPath: string,
  list: (absPath: string) => Promise<string[]> = listPairedSidecars,
): Promise<string[]> {
  const sidecars = await list(absPath);
  if (sidecars.length === 0) return sidecars;
  const shared = await sidecarStemOwnedByAnotherFile(absPath).catch((error: unknown) => {
    if (errnoCode(error) === 'ENOENT') return false;
    throw error;
  });
  return shared
    ? sidecars.filter((sidecar) => isLegacyBackupSidecarOf(absPath, sidecar))
    : sidecars;
}

export type PurgeFailureSink = (target: string, error: unknown) => void;

async function unlinkInsideTrash(
  target: string,
  libraryRoot: string,
  onFailure: PurgeFailureSink,
): Promise<boolean> {
  try {
    const canonical = await checkTrashPurgeTarget(target, libraryRoot);
    if (canonical !== null) await unlinkPrimaryForPurge(canonical);
    return true;
  } catch (error) {
    if (errnoCode(error) === 'ENOENT') return true;
    onFailure(target, error);
    return false;
  }
}

/** Unlink the trashed copy, then its paired sidecars, each only after it
 * passes the Trash jail. Returns how many unlinks failed or were refused. */
export async function unlinkTrashedCopy(
  copy: TrashedCopy,
  onFailure: PurgeFailureSink,
): Promise<number> {
  const sidecars = await ownSidecarsOf(copy.absPath);
  const originalOk = await unlinkInsideTrash(copy.absPath, copy.libraryRoot, onFailure);
  const sidecarOk = await Promise.all(
    sidecars.map((sidecar) => unlinkInsideTrash(sidecar, copy.libraryRoot, onFailure)),
  );
  return [originalOk, ...sidecarOk].filter((ok) => !ok).length;
}

/**
 * Erase the asset's recorded Apple companions. They stay beside the original
 * rather than moving into Trash, and belong to the photo, so they are kept
 * while an untrashed copy of it remains. Throws when one needs a retry.
 */
export async function purgeTrashedCopyCompanions(
  copy: TrashedCopy,
  asset: Partial<Record<AppleCompanionSlot, string | null>> & Pick<AssetDoc, 'fileinfo'>,
  libraries: ReadonlyMap<string, string>,
): Promise<void> {
  if (copy.survivor !== null) return;
  const companions = await resolvePurgeCompanions(
    assetLibraryPath(asset, libraries)!,
    asset,
    copy.absPath,
  );
  for (const companion of companions) {
    if (!(await refusesFileUnderMarker(companion))) await unlinkPrimaryForPurge(companion);
  }
}

/** The warn-level failure sink both purge surfaces log through. */
export function logPurgeFailure(
  log: { warn: (fields: object, message: string) => void },
  message: string,
): PurgeFailureSink {
  return (target, error) =>
    log.warn({ target, err: error instanceof Error ? error.message : error }, message);
}
