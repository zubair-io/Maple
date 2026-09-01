/**
 * Same-file classification + the case-only-rename special case (#2704) —
 * split out of `fs/relocate.ts` to keep that file under its file-size
 * budget headroom (CONTRIBUTING.md's 570-line ceiling on a changed file).
 * `relocate.ts`'s `relocateFile` is the only caller; everything here is
 * private to that relationship except the exported `SameFileClassification`
 * type and functions themselves.
 */
import * as path from 'node:path';
import * as fs from './mirrored.ts';
import { listPairedSidecars } from './xmp-conflict.ts';
import { sidecarRenameTarget } from './sidecar-rename.ts';
import { child as childLogger } from '../log.ts';
import type { RelocateRequest, RelocateOutcome } from './relocate.ts';

const log = childLogger('fs/relocate');

// ---------------------------------------------------------------------------
// Same-file guard
// ---------------------------------------------------------------------------

/** Resolve `p` to a canonical form for a same-file comparison: only the
 * PARENT directory is symlink-resolved (via `realpath`) — the basename is
 * always rejoined literally, never resolved as part of the full path.
 *
 * That split is deliberate, not incidental. `fs.realpath` on a
 * case-insensitive-but-case-preserving filesystem (APFS default, NTFS)
 * resolves a query that differs only in case to the file's STORED casing —
 * so realpath-ing the FULL path (basename included) would silently fold
 * `IMG.CR3` and `img.cr3` to the identical canonical string whenever one of
 * them already exists, making a same-file check built on it reject a
 * legitimate case-only rename. Realpath-ing only the directory sidesteps
 * that: two paths differing solely in their basename's case always compare
 * as different (case-sensitive string equality on the literal basename),
 * while a symlinked PARENT directory is still caught (its target is
 * resolved before the basename is reattached). Falls back to
 * `path.resolve` when even the parent doesn't exist yet — which can only
 * happen when the parent is freshly absent and therefore cannot be a
 * pre-existing symlink aliasing the source. */
async function canonicalizeForComparison(p: string): Promise<string> {
  const dir = path.dirname(p);
  try {
    const realDir = await fs.realpath(dir);
    return path.join(realDir, path.basename(p));
  } catch {
    return path.resolve(p);
  }
}

export type SameFileClassification = 'identical' | 'case-only-rename' | 'different';

/** Classifies whether `source` and `target` name the same on-disk location —
 * directly, or through a symlinked ancestor directory — versus merely
 * differing in case (a legitimate rename on a case-insensitive-but-case-
 * preserving filesystem like APFS default/NTFS) versus genuinely different
 * locations (#2704 — mirrors the Swift/C# twins' `classifySameFile`:
 * `LocalFileOperations.swift`, `LocalFileOperations.cs`).
 *
 * `identical` guards the load-bearing invariant that a relocate never
 * deletes the only copy of a file: without it, a destination that resolves
 * to the source (most directly via `collision: 'replace'`) would copy the
 * source onto itself and then, in `mode: 'move'`, unlink the only remaining
 * copy.
 *
 * Comparing only the PARENT directory's canonical form (never the
 * basename — see `canonicalizeForComparison`'s doc) is what lets
 * `case-only-rename` be told apart from `identical` at all: a full-path
 * `realpath` on a case-insensitive filesystem resolves a query that differs
 * only in case to the file's STORED casing, folding `IMG.CR3` and `img.cr3`
 * to one identical string whenever either already exists. */
export async function classifySameFile(
  source: string,
  target: string,
): Promise<SameFileClassification> {
  const [canonicalSource, canonicalTarget] = await Promise.all([
    canonicalizeForComparison(source),
    canonicalizeForComparison(target),
  ]);
  const sourceDir = path.dirname(canonicalSource);
  const targetDir = path.dirname(canonicalTarget);
  if (sourceDir !== targetDir) return 'different';

  const sourceBase = path.basename(canonicalSource);
  const targetBase = path.basename(canonicalTarget);
  if (sourceBase === targetBase) return 'identical';
  if (sourceBase.toLowerCase() === targetBase.toLowerCase()) return 'case-only-rename';
  return 'different';
}

type SidecarRename = { from: string; to: string };
type PrimaryRenameResult =
  { ok: true; renamedSidecars: SidecarRename[] } | { ok: false; error: string };

/** Renames the primary file directly (`fs.rename`, no staged copy), then
 * best-effort renames every paired sidecar alongside — matching
 * `deleteOriginals`'s "one bad sidecar never blocks the primary relocate"
 * contract: a sidecar that fails to follow is logged and left at its
 * OLD-casing name rather than reverting the primary. Split out of
 * `performCaseOnlyRename` to keep that function's own complexity down
 * (#2704 fallow-audit). */
async function renamePrimaryAndSidecars(req: RelocateRequest): Promise<PrimaryRenameResult> {
  const sourceSidecars = await listPairedSidecars(req.sourceAbsPath);
  try {
    await fs.rename(req.sourceAbsPath, req.destAbsPath);
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }

  const renamedSidecars: SidecarRename[] = [];
  for (const sidecar of sourceSidecars) {
    const dest = sidecarRenameTarget(req.sourceAbsPath, req.destAbsPath, sidecar);
    if (!dest) continue; // defensive — mirrors copyPrimaryAndSidecars
    try {
      await fs.rename(sidecar, dest);
      renamedSidecars.push({ from: sidecar, to: dest });
    } catch (err) {
      log.warn(
        { sidecar, dest, err: err instanceof Error ? err.message : err },
        'relocate: case-only-rename sidecar rename failed — left at its old casing',
      );
    }
  }
  return { ok: true, renamedSidecars };
}

/** Renames the primary + every sidecar that DID rename back to their
 * original casing — the "revert" for a case-only rename's failed
 * `onVerified`, mirroring the copy-verify-delete path's "a failed repoint
 * leaves the source untouched" contract. There is no staged temp copy here
 * to simply discard (an atomic `fs.rename` has no partial state), so
 * reverting means undoing the renames themselves; best-effort, since a
 * revert failure would otherwise mask the ORIGINAL repoint error. */
async function revertCaseOnlyRename(
  req: RelocateRequest,
  renamedSidecars: readonly SidecarRename[],
): Promise<void> {
  await fs.rename(req.destAbsPath, req.sourceAbsPath).catch(() => {});
  for (const { from, to } of renamedSidecars) {
    await fs.rename(to, from).catch(() => {});
  }
}

/** The ONE relocate shape that bypasses BOTH collision handling and
 * copy-verify-delete entirely (#2704): on a case-insensitive-but-case-
 * preserving filesystem, a case-only rename's source and target are the
 * SAME underlying file. A `fs.stat`-based occupied check (`resolveDestination`'s
 * auto-suffix path) reads the target as "occupied by the source itself" and
 * picks a `.1` suffix instead of performing the intended rename, and a copy
 * would copy the file onto itself. `fs.rename` is what the OS itself uses to
 * update just the stored casing.
 *
 * `onVerified` still runs — there IS an identity to repoint, same shape as
 * any other move — after the primary + sidecar renames (`renamePrimaryAndSidecars`);
 * a repoint failure reverts them (`revertCaseOnlyRename`) before returning
 * the error. */
export async function performCaseOnlyRename(req: RelocateRequest): Promise<RelocateOutcome> {
  const renamed = await renamePrimaryAndSidecars(req);
  if (!renamed.ok) return { kind: 'error', error: renamed.error };

  if (req.onVerified) {
    try {
      await req.onVerified({
        newAbsPath: req.destAbsPath,
        sidecarPaths: renamed.renamedSidecars.map((s) => s.to),
      });
    } catch (err) {
      await revertCaseOnlyRename(req, renamed.renamedSidecars);
      return {
        kind: 'error',
        error: `identity repoint failed: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }

  return {
    kind: 'relocated',
    newAbsPath: req.destAbsPath,
    sidecarPaths: renamed.renamedSidecars.map((s) => s.to),
    renamedOnCollision: false,
  };
}
