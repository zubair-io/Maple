/**
 * Trash file-move primitives shared by DELETE and restore.
 *
 * `moveToTrash` and `moveOutOfTrash` are *pure* file-move logic — no
 * Mongo, no auth. The route handlers compose them with asset-doc
 * updates and HTTP plumbing. Both are now thin wrappers around the
 * generic crash-safe `relocateFile` primitive (`fs/relocate.ts`, #2629):
 * copy the primary + every paired sidecar (canonical + conflict variants),
 * verify, then delete the originals — never a bare rename. Sidecar copy
 * errors are logged but never block the primary move (originals are sacred
 * but losing a sidecar copy is recoverable from search history).
 *
 * `pickFreePath` now lives in `fs/relocate.ts` (the collision-resolution
 * half of the generic primitive) and is re-exported here so existing
 * importers of `fs/trash.ts` keep working unchanged.
 *
 * Path validation: every input must be under the library root; we don't
 * enforce MAPLE_ROOTS here because callers already validated against the
 * registered folder root.
 */

// Mirror-aware drop-in: trash moves replicate to the library's backup root(s).
import * as fs from "./mirrored.ts";
import * as path from "node:path";
import { listPairedSidecars } from "./xmp-conflict.ts";
import { child as childLogger } from "../log.ts";
import { relocateFile, pickFreePath, sidecarRenameTarget } from "./relocate.ts";

const log = childLogger("fs/trash");

export { pickFreePath };

export type MoveResult =
  | { kind: "ok"; newAbsPath: string }
  | { kind: "error"; error: string };

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
export async function moveSidecarsAlongside(
  oldAbsPath: string,
  newAbsPath: string,
): Promise<void> {
  const sidecars = await listPairedSidecars(oldAbsPath);
  for (const sidecar of sidecars) {
    // sidecarRenameTarget (fs/relocate.ts) is the same base-swap computation
    // this function used to inline — shared now so the copy-based relocate
    // primitive and this rename-based mover can't drift apart.
    const destPath = sidecarRenameTarget(oldAbsPath, newAbsPath, sidecar);
    if (!destPath) continue; // defensive
    try {
      await fs.rename(sidecar, destPath);
    } catch (err) {
      log.warn(
        { sidecar, destPath, err: err instanceof Error ? err.message : err },
        "sidecar move failed — RAW moved, sidecar left in place",
      );
    }
  }
}

/** Compute the trash-side absolute path for a RAW under a library root.
 *
 * Separator handling (#2741): on a Windows-hosted server the asset's
 * absolute path arrives with backslashes (node's `path.join` output) while
 * the registered root may carry either form — a literal `root + '/'`
 * prefix check can therefore never match and every trash call 500s. Both
 * sides are compared in forward-slash form, but ONLY when the platform
 * separator is `\` — on POSIX a backslash is a legal filename character,
 * not a separator, and rewriting it would corrupt such names. */
export function computeTrashPath(absPath: string, folderRoot: string): string {
  const toComparable = (p: string) =>
    path.sep === "\\" ? p.replaceAll("\\", "/") : p;
  const root = toComparable(folderRoot).replace(/\/$/, "");
  const abs = toComparable(absPath);
  if (abs !== root && !abs.startsWith(root + "/")) {
    throw new Error(`Path "${absPath}" is not under root "${folderRoot}"`);
  }
  const rel = abs === root ? "" : abs.slice(root.length + 1);
  return path.join(root, ".maple", "trash", rel);
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

/** Map a `relocateFile` outcome onto the trash module's `MoveResult`
 * contract. `'skipped'` cannot happen for either trash caller below — one
 * uses `'auto-suffix'` (never occupied-and-declines) and the other
 * pre-resolves a guaranteed-free path before calling in — so it maps to an
 * error rather than being silently swallowed. */
function toMoveResult(
  outcome: Awaited<ReturnType<typeof relocateFile>>,
): MoveResult {
  switch (outcome.kind) {
    case "relocated":
      return { kind: "ok", newAbsPath: outcome.newAbsPath };
    case "error":
      return { kind: "error", error: outcome.error };
    case "skipped":
      return {
        kind: "error",
        error: "relocate: unexpected collision-skip during a trash move",
      };
  }
}

/**
 * Move `absPath` (a RAW) and every paired sidecar into
 * `<folderRoot>/.maple/trash/<rel>`. Returns the new RAW abs_path.
 *
 * If the trash target already exists (re-delete of a previously restored
 * file with the same name), a numeric suffix `.N` is appended
 * (`relocateFile`'s `'auto-suffix'` collision policy — the file-management
 * design doc's "unattended op" case: nobody is watching a trash sweep to
 * answer a Skip/Replace/Keep Both prompt).
 *
 * Built on the generic `relocateFile` primitive (#2629): copy the RAW +
 * sidecars into place, verify, THEN delete the originals — never a bare
 * rename. Sidecar moves are best-effort: a sidecar that fails to copy is
 * logged and left at its original location; it never blocks the RAW move.
 * The trashed sidecar's name follows the same base-replacement applied to
 * the RAW (so `IMG_1 (conflict from Mac).xmp` follows `IMG_1.ARW` →
 * `IMG_1.1.ARW` to `IMG_1.1 (conflict from Mac).xmp`).
 */
export async function moveToTrash(
  absPath: string,
  folderRoot: string,
): Promise<MoveResult> {
  const trashTarget = computeTrashPath(absPath, folderRoot);
  const outcome = await relocateFile({
    sourceAbsPath: absPath,
    destAbsPath: trashTarget,
    mode: "move",
    collision: "auto-suffix",
    callerTag: "moveToTrash",
  });
  return toMoveResult(outcome);
}

/**
 * Move a trashed RAW (and its paired sidecars) from `trashAbsPath` back
 * to `targetAbsPath`. If the target collides, a `.restored[.N]` suffix is
 * appended to the basename (computed here — `pickFreeRestoredPath` is
 * restore's own naming scheme, distinct from `relocateFile`'s generic
 * `.N` auto-suffix, so the free path is resolved before handing off).
 * Sidecar names follow the new RAW base.
 *
 * Built on the generic `relocateFile` primitive (#2629), collision policy
 * `'replace'`: the destination was already resolved to be free above, so
 * `relocateFile` is told to use it as-is (a same-instant race lands on the
 * same overwrite-on-rename semantics the prior bare `fs.rename` had).
 */
export async function moveOutOfTrash(
  trashAbsPath: string,
  targetAbsPath: string,
): Promise<MoveResult> {
  // If the target is free, use it as-is; otherwise apply .restored[.N].
  let freeTarget = targetAbsPath;
  try {
    await fs.stat(targetAbsPath);
    freeTarget = await pickFreeRestoredPath(targetAbsPath);
  } catch {
    /* free */
  }
  const outcome = await relocateFile({
    sourceAbsPath: trashAbsPath,
    destAbsPath: freeTarget,
    mode: "move",
    collision: "replace",
    callerTag: "moveOutOfTrash",
  });
  return toMoveResult(outcome);
}
