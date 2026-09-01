/**
 * `_duplicates` reserved-folder move primitives for the DeDuplicate worker.
 *
 * Mirrors `fs/trash.ts`: a duplicate original (plus its paired XMP sidecars) is
 * RELOCATED — never deleted — into `<libraryRoot>/_duplicates/<original rel
 * path>`, so the operation is fully reversible and honours the "originals are
 * sacred" invariant. The destination preserves the source's relative layout so
 * an operator (or a future restore path) can see where each quarantined file
 * came from.
 *
 * The `_duplicates` tree MUST stay out of the discover sweep — otherwise a moved
 * copy is re-discovered and, because it is byte-identical to the kept copy,
 * content-dedup re-attaches it to the very asset it was split from. The skip is
 * enforced by `DUPLICATES_DIR_NAME` consumers in `workers/discover/sweeper.ts`
 * and `routes/folders.ts`, plus the chokepoint guard in
 * `workers/discover/reserved-trees.ts` (`refusesReservedTreeEvent`) that
 * refuses a quarantined path from ANY event producer.
 */

// Mirror-aware drop-in: the move replicates to the library's backup root(s).
import * as fs from './mirrored.ts';
import * as path from 'node:path';
import { pickFreePath, moveSidecarsAlongside, type MoveResult } from './trash.ts';
import { relativeUnderRoot } from './root-match.ts';

/** Reserved top-level folder (under each library root) holding moved duplicate
 * originals. Excluded from indexing — see the module docstring. */
export const DUPLICATES_DIR_NAME = '_duplicates';

/** Marker file an operator drops into a folder to protect its copies from the
 * DeDuplicate worker. Any asset with a live copy in a `.keep` folder keeps that
 * copy (and every other kept copy) instead of being collapsed to one — see
 * `FileInfo.keep` and `processAsset` in `workers/dedupe.ts`. A dotfile, so the
 * discover sweeper already skips it when listing a directory. */
export const KEEP_FILENAME = '.keep';

/**
 * True when `dir` contains a `.keep` marker file. Best-effort: any error
 * (ENOENT for the common "no marker" case, but also EACCES / ENOTDIR on a
 * vanished or odd path) reads as "no marker". The caller decides what to do.
 */
export async function directoryHasKeepFile(dir: string): Promise<boolean> {
  try {
    await fs.access(path.join(dir, KEEP_FILENAME));
    return true;
  } catch {
    return false;
  }
}

/**
 * Compute the `_duplicates`-side absolute path for a file under a library root:
 * `<root>/_duplicates/<rel>` where `rel` is the file's path relative to `root`.
 * Throws if `absPath` is not under `folderRoot` (same guard as `computeTrashPath`).
 *
 * Containment goes through the shared `relativeUnderRoot` rule (#3094): the
 * previous literal `root + '/'` check could never match on a Windows-hosted
 * server, where absolute paths arrive backslashed, so every quarantine move
 * threw "not under root" — the same failure #2741 fixed for trash.
 */
export function computeDuplicatesPath(absPath: string, folderRoot: string): string {
  const rel = relativeUnderRoot(folderRoot, absPath);
  if (rel === null) {
    throw new Error(`Path "${absPath}" is not under root "${folderRoot}"`);
  }
  return path.join(folderRoot, DUPLICATES_DIR_NAME, rel);
}

/**
 * Move `absPath` (a duplicate original) and every paired sidecar into
 * `<folderRoot>/_duplicates/<rel>`, creating parent dirs and suffixing `.N` on
 * collision so an existing quarantined file is never overwritten. Returns the
 * new absolute path. Sidecar moves are best-effort (see `moveSidecarsAlongside`).
 */
export async function moveToDuplicates(absPath: string, folderRoot: string): Promise<MoveResult> {
  const target = computeDuplicatesPath(absPath, folderRoot);
  await fs.mkdir(path.dirname(target), { recursive: true });
  const freeTarget = await pickFreePath(target, 'moveToDuplicates');
  try {
    await fs.rename(absPath, freeTarget);
  } catch (err) {
    return { kind: 'error', error: err instanceof Error ? err.message : String(err) };
  }
  await moveSidecarsAlongside(absPath, freeTarget);
  return { kind: 'ok', newAbsPath: freeTarget };
}
