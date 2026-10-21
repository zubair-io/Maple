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
import {
  assetDestinationOccupied,
  publishSidecarSnapshot,
  settleCarriedSidecar,
} from './sidecar-ownership.ts';
import { listPairedSidecars } from './xmp-conflict.ts';
import {
  hasLegacyBackupEdit,
  isLegacyBackupSidecarOf,
  oldNameEditUnlisted,
} from './legacy-backup-sidecar.ts';
import { publishExclusive, revertCreated, type RelocatePublication } from './relocate-publish.ts';
import { sidecarRenameTarget } from './sidecar-rename.ts';
import { relativeUnderRoot } from './root-match.ts';
import { child as childLogger } from '../log.ts';

const log = childLogger('fs/duplicates');

/** Reserved top-level folder (under each library root) holding moved duplicate
 * originals. Excluded from indexing — see the module docstring. */
export const DUPLICATES_DIR_NAME = '_duplicates';

/** Marker file an operator drops into a folder to protect its copies from the
 * DeDuplicate worker. Any asset with a live copy in a `.keep` folder keeps that
 * copy (and every other kept copy) instead of being collapsed to one — see
 * `FileInfo.keep` and `processAsset` in `workers/dedupe.ts`. A dotfile, so the
 * discover sweeper already skips it when listing a directory. */
const KEEP_FILENAME = '.keep';

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

/** Publish the photo's old-name edit at its destination ahead of the primary. */
async function publishOldNameAhead(
  absPath: string,
  target: string,
  ownSidecars: readonly string[],
  published: RelocatePublication[],
): Promise<{ source: string; dest: string; snapshot: Buffer } | null> {
  const legacy = ownSidecars.find((sidecar) => isLegacyBackupSidecarOf(absPath, sidecar));
  if (legacy === undefined) return null;
  const dest = sidecarRenameTarget(absPath, target, legacy);
  if (dest === null) return null;
  return { source: legacy, dest, snapshot: await publishSidecarSnapshot(legacy, dest, published) };
}

/**
 * Move `absPath` (a duplicate original) and every paired sidecar into
 * `<folderRoot>/_duplicates/<rel>`, creating parent dirs and suffixing `.N` on
 * collision so an existing quarantined file is never overwritten. Returns the
 * new absolute path. Sidecar moves are best-effort (see `moveSidecarsAlongside`),
 * except the old-name edit, which is published first: if that fails, nothing moves.
 */
export async function moveToDuplicates(absPath: string, folderRoot: string): Promise<MoveResult> {
  const target = computeDuplicatesPath(absPath, folderRoot);
  await fs.mkdir(path.dirname(target), { recursive: true });
  const ownSidecars = await listPairedSidecars(absPath);
  if (await oldNameEditUnlisted(absPath, ownSidecars)) {
    return {
      kind: 'error',
      error: "moveToDuplicates: the photo's old-name backup edit can't be read",
    };
  }
  const freeTarget = await pickFreePath(target, 'moveToDuplicates', (candidate) =>
    assetDestinationOccupied(candidate, ownSidecars, absPath),
  );
  // The old-name edit is published before the primary moves: if it can't be,
  // nothing moves; left behind, nothing would find it again (#5063).
  const published: RelocatePublication[] = [];
  const ahead = await (async () => {
    try {
      const carried = await publishOldNameAhead(absPath, freeTarget, ownSidecars, published);
      await fs.rename(absPath, freeTarget);
      return carried;
    } catch (err) {
      await revertCreated(published);
      return err instanceof Error ? err : new Error(String(err));
    }
  })();
  if (ahead instanceof Error) return { kind: 'error', error: ahead.message };
  // Settled against its snapshot, so a save since the copy ahead is carried too.
  if (ahead) {
    await settleCarriedSidecar(ahead.source, ahead.dest, ahead.snapshot, false).catch((err) => {
      log.warn({ source: ahead.source, err: String(err) }, 'old-name sidecar settle failed');
    });
  }
  const kept = await keepPhotoWithOldNameEdit(absPath, freeTarget);
  if (kept !== 'moved' && kept !== 'blocked') return kept;
  await moveSidecarsAlongside(absPath, freeTarget, kept === 'blocked');
  return { kind: 'ok', newAbsPath: freeTarget };
}

/** An old-name edit still at the old path (a settle that kept its source) is
 * found only beside its photo (#5063). Checked before the other sidecars move,
 * the photo goes back beside it and the move reports failure, so the asset
 * keeps that location with all its sidecars. When the photo can't go back (a
 * new file took the old path, an I/O error), the move completes so the asset
 * follows its photo, and its sidecars are copied rather than moved. Never throws. */
async function keepPhotoWithOldNameEdit(
  absPath: string,
  movedTo: string,
): Promise<MoveResult | 'moved' | 'blocked'> {
  if (!(await hasLegacyBackupEdit(absPath))) return 'moved';
  const back = await publishExclusive(movedTo, absPath).then(
    () => true,
    (err: unknown) => {
      log.error(
        { absPath, movedTo, err: err instanceof Error ? err.message : err },
        'moveToDuplicates: the photo could not go back beside its old-name edit — move completed, sidecars copied',
      );
      return false;
    },
  );
  if (!back) return 'blocked';
  await fs.unlink(movedTo).catch(() => {});
  log.error({ absPath }, 'moveToDuplicates: an old-name backup edit stayed behind — move undone');
  return {
    kind: 'error',
    error: "moveToDuplicates: the photo's old-name backup edit stayed behind",
  };
}
