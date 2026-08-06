/**
 * Generic crash-safe relocate primitive (#2629) — the single move/copy path
 * every file-management operation builds on: trash, on-demand library
 * relocate, and (in later Milestone 23 tickets) rename, drag-to-folder, and
 * folder move.
 *
 * Contract (see docs/superpowers/specs/2026-08-04-file-management-design.md
 * § "Core architecture" — the numbered list below matches that doc 1:1):
 *
 *   1. Resolve the destination path; on collision either ask the caller
 *      (`'skip' | 'replace' | 'keep-both'`) for user-initiated ops, or
 *      auto-suffix (`'auto-suffix'`, `pickFreePath`-style) for unattended
 *      ops. `'keep-both'` uses the exact same suffixing as `'auto-suffix'`
 *      — the two only differ in caller intent/telemetry.
 *   2. Copy the primary file to a temp sibling of the destination (copy,
 *      never a bare rename/move — crash safety).
 *   3. Verify the copy is byte-identical to the source, then atomically
 *      publish it via `rename` into its final place.
 *   4. Carry every paired `.xmp` sidecar alongside, same base-swap naming
 *      `moveSidecarsAlongside` (`fs/trash.ts`) uses — reused here via
 *      `sidecarRenameTarget`. Best-effort: a sidecar that fails to copy is
 *      logged and left at its original location; it never blocks or
 *      reverts the primary relocate.
 *   5. Identity repoint: the optional `onVerified` hook runs here, between
 *      the verified copy and the delete-of-original — asset-aware callers
 *      (`library/relocate-asset.ts`) use it to repoint the Mongo `fileinfo`
 *      doc in the same window `workers/migration/move-backup-asset.ts`
 *      already uses for its own repoint-between-verify-and-delete ordering.
 *   6. On `mode: 'move'`, delete the original primary + every sidecar that
 *      was actually copied.
 *   7. (Stage-version bump, if any, is the caller's concern inside
 *      `onVerified` — this module never touches cache files directly; the
 *      cache key is path-derived, see docs/caching.md.)
 *   8. Return the new address.
 *
 * Failure direction is load-bearing: any failure up to and including a
 * failed `onVerified` leaves the original completely untouched — every copy
 * made so far is reverted. The only unsafe window is the delete itself
 * (step 6): a copy-succeeded-but-delete-failed leaves a harmless duplicate,
 * never data loss.
 */

import * as fs from "./mirrored.ts";
import * as path from "node:path";
import * as crypto from "node:crypto";
import { listPairedSidecars } from "./xmp-conflict.ts";
import { filesIdentical } from "../backup/fs-util.ts";
import { child as childLogger } from "../log.ts";

const log = childLogger("fs/relocate");

export type RelocateMode = "move" | "copy";

/** How to resolve a destination that's already occupied.
 *  - `'auto-suffix'` / `'keep-both'` — pick the next free `.N` sibling
 *    (`pickFreePath`). Unattended ops use `'auto-suffix'`; a user who
 *    explicitly chose "Keep Both" uses `'keep-both'` — same mechanics.
 *  - `'skip'` — do nothing, report `{ kind: 'skipped' }`.
 *  - `'replace'` — overwrite whatever is at the destination. */
export type CollisionPolicy = "auto-suffix" | "skip" | "replace" | "keep-both";

export interface RelocateVerifiedInfo {
  newAbsPath: string;
  /** Absolute paths of every sidecar successfully copied alongside. */
  sidecarPaths: string[];
}

export interface RelocateRequest {
  sourceAbsPath: string;
  /** Desired destination — pre-collision-resolution for `'auto-suffix'` /
   * `'keep-both'`; used as-is for `'skip'` / `'replace'`. */
  destAbsPath: string;
  mode: RelocateMode;
  collision: CollisionPolicy;
  /** Tag surfaced in `pickFreePath`'s collision-log (e.g. `'moveToTrash'`). */
  callerTag?: string;
  /** Invoked after the primary + sidecars are copied and verified, before
   * any delete. Throwing (or the returned promise rejecting) aborts the
   * whole relocate: every copy made so far is reverted and the source is
   * left untouched. Omit when the caller has no identity to repoint (a bare
   * FS move, e.g. trash). */
  onVerified?: (info: RelocateVerifiedInfo) => Promise<void>;
}

export type RelocateOutcome =
  | {
      kind: "relocated";
      newAbsPath: string;
      sidecarPaths: string[];
      /** True when the collision policy actually suffixed the destination
       * away from the caller's requested `destAbsPath`. Only ever true for
       * `'auto-suffix'` / `'keep-both'`. */
      renamedOnCollision: boolean;
    }
  | { kind: "skipped"; reason: "collision" }
  | { kind: "error"; error: string };

// ---------------------------------------------------------------------------
// Collision resolution
// ---------------------------------------------------------------------------

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
export async function pickFreePath(
  basePath: string,
  caller?: string,
): Promise<string> {
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
        { caller: caller ?? "unknown", collision: basePath, chosen: cand },
        "pickFreePath: destination occupied — suffixed path chosen (this creates a .N. filename)",
      );
      return cand;
    }
  }
  throw new Error(
    `pickFreePath: collision — exceeded 1000 candidate paths for ${basePath}`,
  );
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await fs.stat(p);
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Sidecar base-swap (shared with `moveSidecarsAlongside` in `fs/trash.ts`)
// ---------------------------------------------------------------------------

/** Compute a sidecar's destination path when its RAW moves from
 * `oldAbsPath` to `newAbsPath`, applying the SAME base-swap
 * `moveSidecarsAlongside` (`fs/trash.ts`) uses — e.g.
 * `IMG_1 (conflict from Mac).xmp` follows `IMG_1.ARW` → `IMG_1.1.ARW` to
 * `IMG_1.1 (conflict from Mac).xmp`. Returns `null` (defensive skip) when
 * the sidecar's name doesn't start with the RAW's old base. */
export function sidecarRenameTarget(
  oldAbsPath: string,
  newAbsPath: string,
  sidecarAbsPath: string,
): string | null {
  const oldBase = path.basename(oldAbsPath, path.extname(oldAbsPath));
  const newBase = path.basename(newAbsPath, path.extname(newAbsPath));
  const sidecarName = path.basename(sidecarAbsPath);
  if (!sidecarName.startsWith(oldBase)) return null;
  const renamed = newBase + sidecarName.slice(oldBase.length);
  return path.join(path.dirname(newAbsPath), renamed);
}

// ---------------------------------------------------------------------------
// Copy + verify + publish
// ---------------------------------------------------------------------------

/** `.tmp.` must appear in the basename — `fs/mirrored.ts`'s
 * `isReplicablePath` uses that literal substring to recognise (and skip
 * replicating) the codebase's standard "write a temp, then rename into
 * place" atomic-publish idiom. */
function tempPathFor(finalDst: string): string {
  return `${finalDst}.tmp.${process.pid}-${crypto.randomBytes(4).toString("hex")}`;
}

/** Copy `src` to a temp sibling of `finalDst`, verify it's byte-identical,
 * then atomically publish it via `rename` (overwrites `finalDst` if
 * present). On a verify failure the temp is removed and the error
 * propagates — `src` and any prior `finalDst` occupant are untouched. */
async function copyVerifiedIntoPlace(
  src: string,
  finalDst: string,
): Promise<void> {
  const tmp = tempPathFor(finalDst);
  await fs.copyFile(src, tmp);
  if (!(await filesIdentical(src, tmp))) {
    await fs.unlink(tmp).catch(() => {});
    throw new Error(
      `relocate: copy verification failed: ${src} -> ${finalDst}`,
    );
  }
  await fs.rename(tmp, finalDst);
}

async function revertCreated(createdPaths: string[]): Promise<void> {
  for (const p of createdPaths) {
    await fs.unlink(p).catch(() => {});
  }
}

// ---------------------------------------------------------------------------
// The primitive
// ---------------------------------------------------------------------------

export async function relocateFile(
  req: RelocateRequest,
): Promise<RelocateOutcome> {
  const { sourceAbsPath, mode, collision, onVerified } = req;

  // 1. Resolve the destination per the caller's collision policy.
  let finalDest = req.destAbsPath;
  if (collision === "auto-suffix" || collision === "keep-both") {
    finalDest = await pickFreePath(
      req.destAbsPath,
      req.callerTag ?? "relocate",
    );
  } else if (collision === "skip") {
    if (await pathExists(req.destAbsPath)) {
      return { kind: "skipped", reason: "collision" };
    }
  }
  // 'replace': use req.destAbsPath as given — overwrite whatever is there.

  await fs.mkdir(path.dirname(finalDest), { recursive: true });

  const createdPaths: string[] = [];
  try {
    // 2-3. Copy + verify + publish the primary.
    await copyVerifiedIntoPlace(sourceAbsPath, finalDest);
    createdPaths.push(finalDest);

    // 4. Carry the paired sidecars alongside (best-effort).
    const sourceSidecars = await listPairedSidecars(sourceAbsPath);
    const copiedSidecars: string[] = [];
    const movedSidecarSources: string[] = [];
    for (const sidecar of sourceSidecars) {
      const dest = sidecarRenameTarget(sourceAbsPath, finalDest, sidecar);
      if (!dest) continue; // defensive — mirrors moveSidecarsAlongside
      try {
        await copyVerifiedIntoPlace(sidecar, dest);
        createdPaths.push(dest);
        copiedSidecars.push(dest);
        movedSidecarSources.push(sidecar);
      } catch (err) {
        log.warn(
          { sidecar, dest, err: err instanceof Error ? err.message : err },
          "relocate: sidecar copy failed — original left in place",
        );
      }
    }

    // 5. Identity repoint, between verify and delete. A throw here reverts
    //    every copy made so far and leaves the source untouched.
    if (onVerified) {
      try {
        await onVerified({
          newAbsPath: finalDest,
          sidecarPaths: copiedSidecars,
        });
      } catch (err) {
        await revertCreated(createdPaths);
        return {
          kind: "error",
          error: `identity repoint failed: ${err instanceof Error ? err.message : String(err)}`,
        };
      }
    }

    // 6. Delete the originals — move mode only, and only the sidecars that
    //    actually got copied (one left in place on a copy failure keeps its
    //    original, per the best-effort contract above).
    if (mode === "move") {
      await fs.unlink(sourceAbsPath).catch((err) => {
        log.warn(
          { sourceAbsPath, err: err instanceof Error ? err.message : err },
          "relocate: source primary unlink failed after a verified copy — a duplicate is left on disk (acceptable failure direction, never data loss)",
        );
      });
      for (const src of movedSidecarSources) {
        await fs.unlink(src).catch((err) => {
          log.warn(
            { src, err: err instanceof Error ? err.message : err },
            "relocate: source sidecar unlink failed after a verified copy",
          );
        });
      }
    }

    return {
      kind: "relocated",
      newAbsPath: finalDest,
      sidecarPaths: copiedSidecars,
      renamedOnCollision: finalDest !== req.destAbsPath,
    };
  } catch (err) {
    await revertCreated(createdPaths);
    return {
      kind: "error",
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
