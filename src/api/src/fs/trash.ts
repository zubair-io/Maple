/**
 * Trash file-move primitives shared by DELETE and restore.
 *
 * `moveToTrash` and `moveOutOfTrash` are *pure* file-move logic — no
 * Mongo, no auth. The route handlers compose them with asset-doc
 * updates and HTTP plumbing. Both move the RAW first, then every
 * paired sidecar (canonical + conflict variants); sidecar errors are
 * logged but never block the RAW move (originals are sacred but losing
 * a sidecar copy is recoverable from search history).
 *
 * Atomic-rename via `fs.rename`. Path validation: every input must be
 * under the library root; we don't enforce MAPLE_ROOTS here because
 * callers already validated against the registered folder root.
 */

// Mirror-aware drop-in: trash moves replicate to the library's backup root(s).
import * as fs from './mirrored.ts';
import * as path from 'node:path';
import { listPairedSidecars } from './xmp-conflict.ts';
import { child as childLogger } from '../log.ts';

const log = childLogger('fs/trash');

export type MoveResult = { kind: 'ok'; newAbsPath: string } | { kind: 'error'; error: string };

/**
 * Move every XMP sidecar paired to `oldAbsPath` next to `newAbsPath`, rewriting
 * the basename with the SAME base-swap applied to the RAW so pairing stays
 * correct (e.g. `IMG_1 (conflict from Mac).xmp` follows `IMG_1.ARW` →
 * `IMG_1.1.ARW` to `IMG_1.1 (conflict from Mac).xmp`).
 *
 * Best-effort: a sidecar that fails to move is logged and skipped — the RAW has
 * already moved and a lost sidecar copy is recoverable. Shared by `moveToTrash`,
 * `moveOutOfTrash`, and the DeDuplicate worker's `moveToDuplicates`.
 */
export async function moveSidecarsAlongside(oldAbsPath: string, newAbsPath: string): Promise<void> {
  const oldBase = path.basename(oldAbsPath, path.extname(oldAbsPath));
  const newBase = path.basename(newAbsPath, path.extname(newAbsPath));
  const sidecars = await listPairedSidecars(oldAbsPath);
  for (const sidecar of sidecars) {
    const sidecarName = path.basename(sidecar);
    if (!sidecarName.startsWith(oldBase)) continue; // defensive
    const renamed = newBase + sidecarName.slice(oldBase.length);
    const destPath = path.join(path.dirname(newAbsPath), renamed);
    try {
      await fs.rename(sidecar, destPath);
    } catch (err) {
      log.warn(
        { sidecar, destPath, err: err instanceof Error ? err.message : err },
        'sidecar move failed — RAW moved, sidecar left in place',
      );
    }
  }
}

/** Compute the trash-side absolute path for a RAW under a library root. */
export function computeTrashPath(absPath: string, folderRoot: string): string {
  const root = folderRoot.replace(/\/$/, '');
  if (absPath !== root && !absPath.startsWith(root + '/')) {
    throw new Error(`Path "${absPath}" is not under root "${root}"`);
  }
  const rel = absPath === root ? '' : absPath.slice(root.length + 1);
  return path.join(root, '.maple', 'trash', rel);
}

/** Append `.N.<ext>` until the path is free. Bounded to 1000 attempts.
 *
 * Pass `caller` so the warn log identifies which code path triggered the
 * collision (e.g. `'moveToTrash'`, `'moveToDuplicates'`, `'migration:primary'`).
 * A collision means the destination already held a file with that name — the
 * returned suffixed path is what actually ends up on disk and in the DB, which
 * is how `_MG_4226.1.ARW`-style names are created.
 *
 * Throws after exhausting all candidates rather than returning the last
 * (occupied) one — the prior behaviour would have let the subsequent
 * `fs.rename` overwrite an existing file, causing data loss.
 *
 * Extensionless-input edge case: `path.extname("/x/foo")` returns `""`, and
 * `basePath.slice(0, -0)` is `""` — naively building `${stem}.${n}${ext}`
 * would produce `.1` (a root-level dotfile), losing the basename entirely.
 * Guard the slice on a non-empty ext so an extensionless input simply gets
 * the suffix appended (`/x/foo` → `/x/foo.1`). */
export async function pickFreePath(basePath: string, caller?: string): Promise<string> {
  try {
    await fs.stat(basePath);
  } catch {
    return basePath; // path is free — no collision, no log
  }
  const ext = path.extname(basePath);
  const stem = ext ? basePath.slice(0, -ext.length) : basePath;
  for (let n = 1; n <= 1000; n++) {
    const cand = `${stem}.${n}${ext}`;
    try {
      await fs.stat(cand);
    } catch {
      log.warn(
        { caller: caller ?? 'unknown', collision: basePath, chosen: cand },
        'pickFreePath: destination occupied — suffixed path chosen (this creates a .N. filename)',
      );
      return cand;
    }
  }
  throw new Error(`pickFreePath: trash collision — exceeded 1000 candidate paths for ${basePath}`);
}

/** Append `.restored[.N]<ext>` until the path is free. Bounded to 1000 attempts.
 *
 * Throws after exhausting all candidates rather than returning the last
 * (occupied) one — the prior behaviour would have let the subsequent
 * `fs.rename` overwrite an existing restored file, causing data loss.
 *
 * Same extensionless guard as `pickFreePath` — see comment there. */
export async function pickFreeRestoredPath(basePath: string): Promise<string> {
  const ext = path.extname(basePath);
  const stem = ext ? basePath.slice(0, -ext.length) : basePath;
  const first = `${stem}.restored${ext}`;
  try {
    await fs.stat(first);
  } catch {
    return first;
  }
  for (let n = 1; n <= 1000; n++) {
    const cand = `${stem}.restored.${n}${ext}`;
    try {
      await fs.stat(cand);
    } catch {
      return cand;
    }
  }
  throw new Error(
    `pickFreeRestoredPath: restore collision — exceeded 1000 candidate paths for ${basePath}`,
  );
}

/**
 * Move `absPath` (a RAW) and every paired sidecar into
 * `<folderRoot>/.maple/trash/<rel>`. Returns the new RAW abs_path.
 *
 * If the trash target already exists (re-delete of a previously restored
 * file with the same name), a numeric suffix `.N` is appended.
 *
 * Sidecar moves are best-effort: a sidecar that fails to move is logged
 * and the operation continues. The trashed sidecar's name is derived
 * from the original sidecar's name with the *same* base-replacement
 * that was applied to the RAW (so `IMG_1 (conflict from Mac).xmp`
 * follows `IMG_1.ARW` → `IMG_1.1.ARW` to `IMG_1.1 (conflict from Mac).xmp`).
 */
export async function moveToTrash(absPath: string, folderRoot: string): Promise<MoveResult> {
  const trashTarget = computeTrashPath(absPath, folderRoot);
  await fs.mkdir(path.dirname(trashTarget), { recursive: true });
  const freeTarget = await pickFreePath(trashTarget, 'moveToTrash');
  try {
    await fs.rename(absPath, freeTarget);
  } catch (err) {
    return { kind: 'error', error: err instanceof Error ? err.message : String(err) };
  }
  await moveSidecarsAlongside(absPath, freeTarget);
  return { kind: 'ok', newAbsPath: freeTarget };
}

/**
 * Move a trashed RAW (and its paired sidecars) from `trashAbsPath` back
 * to `targetAbsPath`. If the target collides, a `.restored[.N]` suffix
 * is appended to the basename. Sidecar names follow the new RAW base.
 */
export async function moveOutOfTrash(
  trashAbsPath: string,
  targetAbsPath: string,
): Promise<MoveResult> {
  await fs.mkdir(path.dirname(targetAbsPath), { recursive: true });
  // If the target is free, use it as-is; otherwise apply .restored[.N].
  let freeTarget = targetAbsPath;
  try {
    await fs.stat(targetAbsPath);
    freeTarget = await pickFreeRestoredPath(targetAbsPath);
  } catch {
    /* free */
  }
  try {
    await fs.rename(trashAbsPath, freeTarget);
  } catch (err) {
    return { kind: 'error', error: err instanceof Error ? err.message : String(err) };
  }
  await moveSidecarsAlongside(trashAbsPath, freeTarget);
  return { kind: 'ok', newAbsPath: freeTarget };
}
