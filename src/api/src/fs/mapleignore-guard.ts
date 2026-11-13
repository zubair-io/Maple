/**
 * The `.mapleignore` disk guards (#5398), run right before anything moves,
 * renames, trashes, writes or deletes a file. They read the disk, never a
 * location's tag, and check both the path as given and its real path (through
 * symlinks), so a link from outside a marked folder cannot reach into one.
 * Maple's own `.maple/` tree (Trash, caches) is never under a guard, so a
 * marker at a library root cannot strand Trash.
 */
import * as path from 'node:path';
import { ignoreVerdict, ignoreVerdictForFile, type IgnoreVerdictMemo } from './mapleignore.ts';
import { resolveRealPathThroughAncestors } from './root.ts';

/** A child name that is never a real entry: only its directory chain matters. */
const MARKER_PROBE = '.mapleignore-probe';

async function chainRefuses(absPath: string): Promise<boolean> {
  if (absPath.split(path.sep).includes('.maple')) return false;
  return (await ignoreVerdictForFile(path.parse(absPath).root, absPath)) !== 'indexed';
}

/** For writers holding only a path: true unless neither the path nor its
 * real path sits under a marker at any ancestor up to the filesystem root. */
export async function refusesFileUnderMarker(absPath: string): Promise<boolean> {
  const logical = path.resolve(absPath);
  if (await chainRefuses(logical)) return true;
  const real = await resolveRealPathThroughAncestors(logical).catch(() => null);
  if (real === null) return true;
  return real !== logical && (await chainRefuses(real));
}

/** For catalog-driven moves of the original in `relDir` under a library
 * `root`: the logical chain (memoized across a batch), then the real path. */
export async function refusesMoveUnderMarker(
  root: string,
  relDir: string,
  memo?: IgnoreVerdictMemo,
): Promise<boolean> {
  const verdict = await (memo ? memo.verdict(root, relDir) : ignoreVerdict(root, relDir));
  if (verdict !== 'indexed') return true;
  const dir = path.join(root, ...relDir.split('/').filter(Boolean));
  return refusesFileUnderMarker(path.join(dir, MARKER_PROBE));
}
