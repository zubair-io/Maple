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

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { listPairedSidecars } from "./xmp.ts";
import { child as childLogger } from "../log.ts";

const log = childLogger("fs/trash");

export type MoveResult =
  | { kind: "ok"; newAbsPath: string }
  | { kind: "error"; error: string };

/** Compute the trash-side absolute path for a RAW under a library root. */
export function computeTrashPath(absPath: string, folderRoot: string): string {
  const root = folderRoot.replace(/\/$/, "");
  if (absPath !== root && !absPath.startsWith(root + "/")) {
    throw new Error(`Path "${absPath}" is not under root "${root}"`);
  }
  const rel = absPath === root ? "" : absPath.slice(root.length + 1);
  return path.join(root, ".maple", "trash", rel);
}

/** Append `.N.<ext>` until the path is free. Bounded to 1000 attempts. */
async function pickFreePath(basePath: string): Promise<string> {
  try { await fs.stat(basePath); } catch { return basePath; }
  const ext = path.extname(basePath);
  const stem = basePath.slice(0, -ext.length);
  for (let n = 1; n <= 1000; n++) {
    const cand = `${stem}.${n}${ext}`;
    try { await fs.stat(cand); } catch { return cand; }
  }
  return `${stem}.1000${ext}`;
}

/** Append `.restored[.N]<ext>` until the path is free. Bounded to 1000 attempts. */
async function pickFreeRestoredPath(basePath: string): Promise<string> {
  const ext = path.extname(basePath);
  const stem = basePath.slice(0, -ext.length);
  const first = `${stem}.restored${ext}`;
  try { await fs.stat(first); } catch { return first; }
  for (let n = 1; n <= 1000; n++) {
    const cand = `${stem}.restored.${n}${ext}`;
    try { await fs.stat(cand); } catch { return cand; }
  }
  return `${stem}.restored.1000${ext}`;
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
  const freeTarget = await pickFreePath(trashTarget);
  try {
    await fs.rename(absPath, freeTarget);
  } catch (err) {
    return { kind: "error", error: err instanceof Error ? err.message : String(err) };
  }
  // Move sidecars. Each conflict sidecar carries the OLD base; the moved
  // name swaps to the NEW base so pairing stays correct in trash.
  const oldBase = path.basename(absPath, path.extname(absPath));
  const newBase = path.basename(freeTarget, path.extname(freeTarget));
  const sidecars = await listPairedSidecars(absPath);
  for (const sidecar of sidecars) {
    const sidecarName = path.basename(sidecar);
    if (!sidecarName.startsWith(oldBase)) continue; // defensive
    const renamed = newBase + sidecarName.slice(oldBase.length);
    const destPath = path.join(path.dirname(freeTarget), renamed);
    try {
      await fs.rename(sidecar, destPath);
    } catch (err) {
      log.warn(
        { sidecar, destPath, err: err instanceof Error ? err.message : err },
        "sidecar move failed — RAW moved, sidecar left in place",
      );
    }
  }
  return { kind: "ok", newAbsPath: freeTarget };
}

/**
 * Move a trashed RAW (and its paired sidecars) from `trashAbsPath` back
 * to `targetAbsPath`. If the target collides, a `.restored[.N]` suffix
 * is appended to the basename. Sidecar names follow the new RAW base.
 */
export async function moveOutOfTrash(trashAbsPath: string, targetAbsPath: string): Promise<MoveResult> {
  await fs.mkdir(path.dirname(targetAbsPath), { recursive: true });
  // If the target is free, use it as-is; otherwise apply .restored[.N].
  let freeTarget = targetAbsPath;
  try {
    await fs.stat(targetAbsPath);
    freeTarget = await pickFreeRestoredPath(targetAbsPath);
  } catch { /* free */ }
  try {
    await fs.rename(trashAbsPath, freeTarget);
  } catch (err) {
    return { kind: "error", error: err instanceof Error ? err.message : String(err) };
  }
  const oldBase = path.basename(trashAbsPath, path.extname(trashAbsPath));
  const newBase = path.basename(freeTarget, path.extname(freeTarget));
  const sidecars = await listPairedSidecars(trashAbsPath);
  for (const sidecar of sidecars) {
    const sidecarName = path.basename(sidecar);
    if (!sidecarName.startsWith(oldBase)) continue;
    const renamed = newBase + sidecarName.slice(oldBase.length);
    const destPath = path.join(path.dirname(freeTarget), renamed);
    try {
      await fs.rename(sidecar, destPath);
    } catch (err) {
      log.warn(
        { sidecar, destPath, err: err instanceof Error ? err.message : err },
        "sidecar restore failed — RAW restored, sidecar left in trash",
      );
    }
  }
  return { kind: "ok", newAbsPath: freeTarget };
}
