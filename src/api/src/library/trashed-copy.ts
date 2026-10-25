/**
 * The one copy a Trash purge may erase, and the jail every purge unlink of a
 * photo or sidecar runs inside (#5403). Trashing moves exactly one location
 * into `<library>/.maple/trash/<rel>` and repoints that row there, so the
 * trashed copy is found by its address, never by its position in the location
 * list — the first live location can be an untouched original elsewhere.
 */

import * as path from 'node:path';
import { realpath, unlinkPrimaryForPurge } from '../fs/mirrored.ts';
import { errnoCode } from '../fs/relocate-publish.ts';
import { refusesFileUnderMarker } from '../fs/mapleignore-guard.ts';
import { isWithinRoot } from '../fs/root.ts';
import { listPairedSidecars } from '../fs/xmp-conflict.ts';
import type { AppleCompanionSlot } from '../db/apple-companions.ts';
import type { ObjectId } from '../db/object-id.ts';
import type { AssetDoc, FileInfo } from '../db/schema.ts';
import { assetLibraryPath, isLiveFileInfo } from '../indexer/images.repo.ts';
import { resolvePurgeCompanions } from './purge-rendered-companion.ts';

const TRASH_SEGMENTS = ['.maple', 'trash'] as const;
const TRASH_REL_DIR = TRASH_SEGMENTS.join('/');

function isTrashRelPath(relDir: string): boolean {
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
 * or its library is unregistered. */
export function resolveTrashedCopy(
  fileinfo: readonly FileInfo[] | undefined,
  libraries: ReadonlyMap<string, string>,
): TrashedCopy | null {
  const live = (fileinfo ?? []).filter((entry) => !entry.deleted_at);
  const trashed = live.find((entry) => isTrashRelPath(entry.path));
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
 * The canonical path to unlink for `target`: its real directory plus its own
 * name. Throws `OutsideTrashError` unless it lies inside
 * `<libraryRoot>/.maple/trash/`, both as written and with symlinked
 * directories followed. Null means the directory holding it no longer exists.
 * The last component is never followed, so a symlink there loses only the link.
 */
export async function checkTrashPurgeTarget(
  target: string,
  libraryRoot: string,
): Promise<string | null> {
  const trashRoot = path.resolve(libraryRoot, ...TRASH_SEGMENTS);
  const resolved = path.resolve(target);
  if (!isStrictlyInside(trashRoot, resolved)) throw new OutsideTrashError(target, libraryRoot);
  const [realTrashRoot, realParent] = await Promise.all([
    realpathOrNull(trashRoot),
    realpathOrNull(path.dirname(resolved)),
  ]);
  if (realTrashRoot === null || realParent === null) return null;
  if (!isWithinRoot(realTrashRoot, realParent)) throw new OutsideTrashError(target, libraryRoot);
  return path.join(realParent, path.basename(resolved));
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
  const sidecars = await listPairedSidecars(copy.absPath);
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
