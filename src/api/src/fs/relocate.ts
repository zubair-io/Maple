/**
 * Generic crash-safe relocate primitive (#2629) — the single move/copy path
 * every file-management operation builds on: trash, on-demand library
 * relocate, and (in later Milestone 23 tickets) rename, drag-to-folder, and
 * folder move.
 *
 * Contract (see docs/superpowers/specs/2026-08-04-file-management-design.md
 * § "Core architecture" — the numbered list below matches that doc, with
 * one deliberate strengthening: the doc's step 3 permits a size+mtime
 * verify for same-filesystem copies, while this implementation always does
 * a full byte-for-byte compare via `filesIdentical` — stronger than the
 * contract's minimum, never weaker):
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

import * as fs from './mirrored.ts';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import { listPairedSidecars } from './xmp-conflict.ts';
import { filesIdentical } from '../backup/fs-util.ts';
import { child as childLogger } from '../log.ts';
import { sidecarRenameTarget } from './sidecar-rename.ts';
import { classifySameFile, performCaseOnlyRename } from './relocate-case-only-rename.ts';

export { sidecarRenameTarget };

const log = childLogger('fs/relocate');

export type RelocateMode = 'move' | 'copy';

/** How to resolve a destination that's already occupied.
 *  - `'auto-suffix'` / `'keep-both'` — pick the next free `.N` sibling
 *    (`pickFreePath`). Unattended ops use `'auto-suffix'`; a user who
 *    explicitly chose "Keep Both" uses `'keep-both'` — same mechanics.
 *  - `'skip'` — do nothing, report `{ kind: 'skipped' }`.
 *  - `'replace'` — overwrite whatever is at the destination. */
export type CollisionPolicy = 'auto-suffix' | 'skip' | 'replace' | 'keep-both';

export interface RelocateVerifiedInfo {
  newAbsPath: string;
  /** Absolute paths of every sidecar successfully copied alongside. */
  sidecarPaths: string[];
  /** New absolute paths of every `extraCompanionAbsPaths` entry successfully
   * copied alongside (#2667) — same best-effort contract as `sidecarPaths`,
   * omitted here (not present) for a companion that failed to copy. */
  companionPaths: string[];
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
  /** Absolute paths of extra non-sidecar companion files to carry alongside
   * the primary (#2667) — e.g. a PhotoKit backup's Apple-rendered JPEG
   * (`apple_rendered_path`). Same treatment as a `.xmp` sidecar: base-swap
   * renamed via `sidecarRenameTarget` when the companion's name shares the
   * primary's base (falling back to an unchanged basename in the new
   * directory when it doesn't — mirrors
   * `workers/migration/restructure-fs.ts`'s `planAndPlace`), copy+verify,
   * best-effort (a companion that fails to copy is logged and left at its
   * original location, same as a sidecar), deleted on `mode: 'move'`. */
  extraCompanionAbsPaths?: string[];
  /** Invoked after the primary + sidecars are copied and verified, before
   * any delete. Throwing (or the returned promise rejecting) aborts the
   * whole relocate: every copy made so far is reverted and the source is
   * left untouched. Omit when the caller has no identity to repoint (a bare
   * FS move, e.g. trash). */
  onVerified?: (info: RelocateVerifiedInfo) => Promise<void>;
}

export type RelocateOutcome =
  | {
      kind: 'relocated';
      newAbsPath: string;
      sidecarPaths: string[];
      /** New absolute paths of every companion successfully copied — see
       * `RelocateVerifiedInfo.companionPaths` (#2667). */
      companionPaths: string[];
      /** True when the collision policy actually suffixed the destination
       * away from the caller's requested `destAbsPath`. Only ever true for
       * `'auto-suffix'` / `'keep-both'`. */
      renamedOnCollision: boolean;
    }
  | { kind: 'skipped'; reason: 'collision' }
  | { kind: 'error'; error: string };

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
  throw new Error(`pickFreePath: collision — exceeded 1000 candidate paths for ${basePath}`);
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
// Copy + verify + publish
// ---------------------------------------------------------------------------

/** `.tmp.` must appear in the basename — `fs/mirrored.ts`'s
 * `isReplicablePath` uses that literal substring to recognise (and skip
 * replicating) the codebase's standard "write a temp, then rename into
 * place" atomic-publish idiom. */
function tempPathFor(finalDst: string): string {
  return `${finalDst}.tmp.${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
}

/** Copy `src` to a temp sibling of `finalDst`, verify it's byte-identical,
 * then atomically publish it via `rename` (overwrites `finalDst` if
 * present). On a verify failure the temp is removed and the error
 * propagates — `src` and any prior `finalDst` occupant are untouched. */
async function copyVerifiedIntoPlace(src: string, finalDst: string): Promise<void> {
  const tmp = tempPathFor(finalDst);
  await fs.copyFile(src, tmp);
  if (!(await filesIdentical(src, tmp))) {
    await fs.unlink(tmp).catch(() => {});
    throw new Error(`relocate: copy verification failed: ${src} -> ${finalDst}`);
  }
  await fs.rename(tmp, finalDst);
}

async function revertCreated(createdPaths: string[]): Promise<void> {
  for (const p of createdPaths) {
    await fs.unlink(p).catch(() => {});
  }
}

// ---------------------------------------------------------------------------
// The primitive — decomposed along the 8-step contract's natural seams so
// each phase (collision resolution, copy+verify, identity repoint, delete)
// is independently readable and testable, and the crash-safety ordering
// between them stays obvious at the `relocateFile` call-site below.
// ---------------------------------------------------------------------------

type DestinationResolution = { kind: 'proceed'; finalDest: string } | { kind: 'skip' };

/** Step 1: resolve the destination per the caller's collision policy.
 * `'auto-suffix'` / `'keep-both'` pick the next free `.N` sibling;
 * `'skip'` declines outright when the destination is occupied; `'replace'`
 * (and a `'skip'` that finds nothing occupying the destination) proceeds
 * with `destAbsPath` exactly as given. */
async function resolveDestination(req: RelocateRequest): Promise<DestinationResolution> {
  if (req.collision === 'auto-suffix' || req.collision === 'keep-both') {
    const finalDest = await pickFreePath(req.destAbsPath, req.callerTag ?? 'relocate');
    return { kind: 'proceed', finalDest };
  }
  if (req.collision === 'skip' && (await pathExists(req.destAbsPath))) {
    return { kind: 'skip' };
  }
  return { kind: 'proceed', finalDest: req.destAbsPath };
}

/** Best-effort copy of one sidecar — logs and reports failure rather than
 * throwing, so one bad sidecar never blocks or reverts the primary relocate
 * (matches `moveSidecarsAlongside`'s "RAW moved, sidecar left in place"
 * contract). */
async function tryCopySidecar(sidecar: string, dest: string): Promise<boolean> {
  try {
    await copyVerifiedIntoPlace(sidecar, dest);
    return true;
  } catch (err) {
    log.warn(
      { sidecar, dest, err: err instanceof Error ? err.message : err },
      'relocate: sidecar copy failed — original left in place',
    );
    return false;
  }
}

/** #2667: where a non-sidecar companion (e.g. `apple_rendered_path`) lands
 * when the primary relocates — the SAME base-swap rename `sidecarRenameTarget`
 * uses, falling back to the companion's unchanged basename in the new
 * directory when its name doesn't share the primary's base. Matches
 * `workers/migration/restructure-fs.ts`'s `planAndPlace` fallback for the
 * same companion. */
function companionRenameTarget(
  oldAbsPath: string,
  newAbsPath: string,
  companionAbsPath: string,
): string {
  const renamed = sidecarRenameTarget(oldAbsPath, newAbsPath, companionAbsPath);
  return renamed ?? path.join(path.dirname(newAbsPath), path.basename(companionAbsPath));
}

/** Best-effort copy of one non-sidecar companion — same contract as
 * `tryCopySidecar` (#2667). */
async function tryCopyCompanion(companion: string, dest: string): Promise<boolean> {
  try {
    await copyVerifiedIntoPlace(companion, dest);
    return true;
  } catch (err) {
    log.warn(
      { companion, dest, err: err instanceof Error ? err.message : err },
      'relocate: companion copy failed — original left in place',
    );
    return false;
  }
}

interface SidecarCopyResult {
  copiedSidecars: string[];
  movedSidecarSources: string[];
  companionPaths: string[];
  movedCompanionSources: string[];
}

/** Steps 2-4: copy + verify + publish the primary, then best-effort carry
 * every paired sidecar and extra companion (#2667) alongside. Pushes every
 * path it creates onto the caller's `createdPaths` accumulator as it goes
 * (not just on success) so a mid-loop throw still leaves the caller able to
 * revert exactly what exists on disk. Throws only for a PRIMARY copy
 * failure — sidecar/companion failures are swallowed by `tryCopySidecar` /
 * `tryCopyCompanion`. */
async function copyPrimaryAndSidecars(
  sourceAbsPath: string,
  finalDest: string,
  collision: CollisionPolicy,
  extraCompanionAbsPaths: string[],
  createdPaths: string[],
): Promise<SidecarCopyResult> {
  await copyVerifiedIntoPlace(sourceAbsPath, finalDest);
  createdPaths.push(finalDest);

  const copiedSidecars: string[] = [];
  const movedSidecarSources: string[] = [];
  const sourceSidecars = await listPairedSidecars(sourceAbsPath);
  for (const sidecar of sourceSidecars) {
    const dest = sidecarRenameTarget(sourceAbsPath, finalDest, sidecar);
    if (!dest) continue; // defensive — mirrors moveSidecarsAlongside
    if (!(await tryCopySidecar(sidecar, dest))) continue;
    createdPaths.push(dest);
    copiedSidecars.push(dest);
    movedSidecarSources.push(sidecar);
  }

  const companionPaths: string[] = [];
  const movedCompanionSources: string[] = [];
  for (const companion of extraCompanionAbsPaths) {
    const dest = companionRenameTarget(sourceAbsPath, finalDest, companion);
    if (!(await tryCopyCompanion(companion, dest))) continue;
    createdPaths.push(dest);
    companionPaths.push(dest);
    movedCompanionSources.push(companion);
  }

  if (sourceSidecars.length === 0 && collision === 'replace') {
    // The incoming asset has no sidecar of its own, but `'replace'` means
    // "the destination now reflects EXACTLY the incoming asset" — a stale
    // sidecar left over from the PREVIOUS occupant must not silently
    // survive and get misattributed to this one (found by the #2633
    // cross-platform parity harness — the Swift twin already avoids this,
    // see `LocalFileOperations.swift`'s matching comment in `planRelocate`).
    // Safe here, unlike a pre-copy delete would be: this only runs AFTER
    // `copyVerifiedIntoPlace` above has already published the new primary
    // successfully, so a copy failure can never reach this point.
    // Best-effort, matching every other sidecar-cleanup path in this file.
    const staleDests = await listPairedSidecars(finalDest);
    for (const stale of staleDests) {
      await fs.unlink(stale).catch(() => {});
    }
  }

  return { copiedSidecars, movedSidecarSources, companionPaths, movedCompanionSources };
}

/** Step 5: run the caller's identity-repoint hook (if any) between the
 * verified copy and the delete. Returns an error message on failure (after
 * reverting every copy made so far — the load-bearing failure-direction
 * guarantee) or `null` on success/absence. */
async function runIdentityRepoint(
  onVerified: RelocateRequest['onVerified'],
  info: RelocateVerifiedInfo,
  createdPaths: string[],
): Promise<string | null> {
  if (!onVerified) return null;
  try {
    await onVerified(info);
    return null;
  } catch (err) {
    await revertCreated(createdPaths);
    return `identity repoint failed: ${err instanceof Error ? err.message : String(err)}`;
  }
}

/** Step 6, move mode only: delete the original primary + every sidecar that
 * was actually copied (one left in place on a copy failure keeps its
 * original, per `tryCopySidecar`'s best-effort contract). Best-effort —
 * a failure here leaves a harmless duplicate on disk, the accepted failure
 * direction, never data loss, so it's logged rather than thrown. */
async function deleteOriginals(
  sourceAbsPath: string,
  movedSidecarSources: string[],
  movedCompanionSources: string[],
): Promise<void> {
  await fs.unlink(sourceAbsPath).catch((err) => {
    log.warn(
      { sourceAbsPath, err: err instanceof Error ? err.message : err },
      'relocate: source primary unlink failed after a verified copy — a duplicate is left on disk (acceptable failure direction, never data loss)',
    );
  });
  for (const src of [...movedSidecarSources, ...movedCompanionSources]) {
    await fs.unlink(src).catch((err) => {
      log.warn(
        { src, err: err instanceof Error ? err.message : err },
        'relocate: source sidecar/companion unlink failed after a verified copy',
      );
    });
  }
}

export async function relocateFile(req: RelocateRequest): Promise<RelocateOutcome> {
  // Classify source vs destination BEFORE any collision resolution runs
  // (found by the #2633 cross-platform parity harness — the Swift and
  // Windows twins already check this first; this used to run AFTER
  // `resolveDestination`, so an `'auto-suffix'`/`'keep-both'` request that
  // named the source as its own destination silently suffixed past the
  // self-collision instead of refusing, and a `'skip'` request returned
  // `{kind:'skipped'}` instead of the same explicit `sameFile` error every
  // other collision policy gives — both diverging from the other two
  // platforms for the exact same call). This must run before ANY copy: the
  // danger is copying the source onto itself and then, in move mode,
  // deleting the only remaining copy.
  const classification = await classifySameFile(req.sourceAbsPath, req.destAbsPath);
  if (classification === 'identical') {
    return {
      kind: 'error',
      error:
        'relocate: destination resolves to the same file as the source — refusing to avoid data loss',
    };
  }
  // #2704: a case-only rename on a case-insensitive-but-case-preserving
  // filesystem (`img.cr3` -> `IMG.CR3`) IS the same underlying file — see
  // `performCaseOnlyRename`'s doc for why it needs its own direct-rename
  // path rather than falling into collision handling / copy-verify-delete
  // below, both of which would misread the target as "occupied by the
  // source itself".
  if (classification === 'case-only-rename') {
    if (req.mode !== 'move') {
      return {
        kind: 'error',
        error:
          'relocate: case-only rename target is the same file as the source on a case-insensitive filesystem — copy is not meaningful',
      };
    }
    return performCaseOnlyRename(req);
  }

  // 1. Resolve the destination per the caller's collision policy.
  const resolution = await resolveDestination(req);
  if (resolution.kind === 'skip') {
    return { kind: 'skipped', reason: 'collision' };
  }
  const { finalDest } = resolution;

  await fs.mkdir(path.dirname(finalDest), { recursive: true });

  const createdPaths: string[] = [];
  try {
    // 2-4. Copy + verify the primary, then carry the sidecars + any extra
    // companions (#2667) alongside.
    const { copiedSidecars, movedSidecarSources, companionPaths, movedCompanionSources } =
      await copyPrimaryAndSidecars(
        req.sourceAbsPath,
        finalDest,
        req.collision,
        req.extraCompanionAbsPaths ?? [],
        createdPaths,
      );

    // 5. Identity repoint, between verify and delete.
    const repointError = await runIdentityRepoint(
      req.onVerified,
      { newAbsPath: finalDest, sidecarPaths: copiedSidecars, companionPaths },
      createdPaths,
    );
    if (repointError) {
      return { kind: 'error', error: repointError };
    }

    // 6. Delete the originals — move mode only.
    if (req.mode === 'move') {
      await deleteOriginals(req.sourceAbsPath, movedSidecarSources, movedCompanionSources);
    }

    return {
      kind: 'relocated',
      newAbsPath: finalDest,
      sidecarPaths: copiedSidecars,
      companionPaths,
      renamedOnCollision: finalDest !== req.destAbsPath,
    };
  } catch (err) {
    await revertCreated(createdPaths);
    return {
      kind: 'error',
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
