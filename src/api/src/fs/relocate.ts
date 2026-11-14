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
 *   3. Verify the copy is byte-identical to the source, then publish it
 *      without replacing any occupant (#4693, `fs/relocate-publish.ts`) —
 *      only `'replace'` renames over the destination. A name another writer
 *      claims first is a collision for the whole asset.
 *   4. Carry every paired `.xmp` sidecar alongside, same base-swap naming
 *      `moveSidecarsAlongside` (`fs/trash.ts`) uses — reused here via
 *      `sidecarRenameTarget` — under the shared-sidecar ownership rule
 *      (#4692, `fs/sidecar-ownership.ts`). A sidecar that fails to copy is
 *      logged and left at its original location; an occupied destination
 *      sidecar is a collision for the whole asset.
 *   5. Identity repoint: the optional `onVerified` hook runs here, between
 *      the verified copy and the delete-of-original — asset-aware callers
 *      (`library/relocate-asset.ts`) use it to repoint the asset's `fileinfo`
 *      location in the same window `workers/migration/move-backup-asset.ts`
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
import { withReplaceSidecarFence } from './relocate-replace-fence.ts';
import {
  PublishCollisionError,
  copyVerifiedIntoPlace,
  releaseDisplaced,
  revertCreated,
  type RelocatePublication,
} from './relocate-publish.ts';
import { child as childLogger } from '../log.ts';
import { sidecarRenameTarget, companionRenameTarget } from './sidecar-rename.ts';
import { classifySameFile, performCaseOnlyRename } from './relocate-case-only-rename.ts';
import {
  isSuffixing,
  pickFreePath,
  replacesOccupants,
  resolveDestination,
} from './relocate-destination.ts';
import {
  planSidecars,
  carryPlannedSidecars,
  listRelocateSidecars,
  removeStaleDestinationSidecars,
  sourceSidecarStays,
  type MovedSidecar,
  type SidecarPlan,
} from './relocate-sidecar-plan.ts';
import { carryLateSidecars } from './relocate-late-sidecar.ts';
import { deleteOriginals } from './relocate-originals.ts';
import {
  CompanionCollisionError,
  carryStackCompanion,
  caseOnlyCompanionRename,
  stackCompanionSidecarPlan,
  stackCompanionTarget,
  type RelocateSidecars,
  type StackCompanionRequest,
} from './relocate-stack.ts';

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
  /** The source each `companionPaths` entry was copied from, index for index. */
  companionSources: string[];
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
  /** Persist the resolved destination before publishing or deleting bytes. */
  onDestinationPrepared?: (destination: string) => Promise<void>;
  /** Revalidate lifecycle ownership after copying, before removing sources. */
  beforeSourceDelete?: () => Promise<void>;
  /** Absolute paths of extra non-sidecar companion files to carry alongside
   * the primary (#2667) — e.g. a PhotoKit backup's Apple-rendered JPEG
   * (`apple_rendered_path`) or Live Photo `.mov` (`apple_live_video_path`).
   * Same treatment as a `.xmp` sidecar: base-swap
   * renamed via `sidecarRenameTarget` when the companion's name shares the
   * primary's base (falling back to an unchanged basename in the new
   * directory when it doesn't — mirrors
   * `workers/migration/restructure-fs.ts`'s `planAndPlace`), copy+verify,
   * best-effort (a companion that fails to copy is logged and left at its
   * original location, same as a sidecar), deleted on `mode: 'move'`. */
  extraCompanionAbsPaths?: string[];
  /** A RAW+JPEG stack's JPEG (#5929): moves under the primary's final stem or
   * the whole relocate reverts; its name counts for the collision policy. */
  stackCompanion?: StackCompanionRequest;
  /** Carry the paired `.xmp` sidecars along (default). `false` moves the
   * primary alone — for a plain file that merely shares its stem with a photo
   * (`photo.txt` beside `photo.dng` + `photo.xmp`), whose sidecars belong to
   * the photo and must stay put (#4694). */
  carrySidecars?: boolean;
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
  /** `collidedAt`, for a stack relocate: the destination name that was taken. */
  | { kind: 'skipped'; reason: 'collision'; collidedAt?: string }
  | { kind: 'error'; error: string };

// ---------------------------------------------------------------------------
// The primitive — decomposed along the 8-step contract's natural seams so
// each phase (collision resolution, copy+verify, identity repoint, delete)
// is independently readable and testable, and the crash-safety ordering
// between them stays obvious at the `relocateFile` call-site below.
// ---------------------------------------------------------------------------

/** Best-effort copy of one non-sidecar companion — same contract as a
 * sidecar (`carryPlannedSidecars`, #2667). Its destination is never
 * collision-resolved by the caller, so it is suffixed around an occupant
 * (review on #2667: an unrelated `.jpg` could hold the base-swapped name,
 * matching `workers/migration/restructure-fs.ts`'s `planAndPlace`), and a
 * name another writer claims mid-publish is suffixed around the same way. */
async function tryCopyCompanion(
  companion: string,
  candidateDest: string,
  createdPaths: RelocatePublication[],
): Promise<string | null> {
  for (let attempt = 0; attempt <= MAX_COLLISION_RETRIES; attempt++) {
    const dest = await pickFreePath(candidateDest, 'relocate:companion');
    try {
      await copyVerifiedIntoPlace(companion, dest, false, createdPaths);
      return dest;
    } catch (err) {
      if (!(err instanceof PublishCollisionError))
        return companionLeftInPlace(companion, dest, err);
    }
  }
  return companionLeftInPlace(companion, candidateDest, 'every suffixed name was claimed');
}

function companionLeftInPlace(companion: string, dest: string, err: unknown): null {
  log.warn(
    { companion, dest, err: err instanceof Error ? err.message : err },
    'relocate: companion copy failed — original left in place',
  );
  return null;
}

interface SidecarCopyResult {
  copiedSidecars: string[];
  movedSidecars: MovedSidecar[];
  companionPaths: string[];
  movedCompanionSources: string[];
  movedStackCompanion: { source: string; dest: string } | null;
}

/** Best-effort carry of every extra companion (#2667) alongside the primary,
 * then the stack's JPEG, which must land (#5929). */
async function carryCompanions(
  req: RelocateRequest,
  finalDest: string,
  createdPaths: RelocatePublication[],
): Promise<
  Pick<SidecarCopyResult, 'companionPaths' | 'movedCompanionSources' | 'movedStackCompanion'>
> {
  const companionPaths: string[] = [];
  const movedCompanionSources: string[] = [];
  for (const companion of req.extraCompanionAbsPaths ?? []) {
    const candidateDest = companionRenameTarget(req.sourceAbsPath, finalDest, companion);
    const dest = await tryCopyCompanion(companion, candidateDest, createdPaths);
    if (!dest) continue;
    companionPaths.push(dest);
    movedCompanionSources.push(companion);
  }
  const stackDest = await carryStackCompanion(req.stackCompanion, finalDest, createdPaths);
  const movedStackCompanion =
    stackDest && req.stackCompanion
      ? { source: req.stackCompanion.sourceAbsPath, dest: stackDest }
      : null;
  if (movedStackCompanion) {
    companionPaths.push(movedStackCompanion.dest);
    movedCompanionSources.push(movedStackCompanion.source);
  }
  return { companionPaths, movedCompanionSources, movedStackCompanion };
}

/** Steps 2-4: copy + verify + publish the primary, then carry every planned
 * sidecar and extra companion (#2667) alongside. Pushes every path it creates
 * onto the caller's `createdPaths` accumulator as it goes (not just on
 * success) so a mid-loop throw still leaves the caller able to revert exactly
 * what exists on disk. Throws for a PRIMARY copy failure or a publication
 * collision — other sidecar/companion failures are logged and skipped. */
async function copyPrimaryAndSidecars(
  req: RelocateRequest,
  finalDest: string,
  sourceSidecars: readonly string[],
  plan: SidecarPlan,
  createdPaths: RelocatePublication[],
): Promise<SidecarCopyResult> {
  await copyVerifiedIntoPlace(
    req.sourceAbsPath,
    finalDest,
    req.collision === 'replace',
    createdPaths,
  );

  const { copiedSidecars, carried } = await carryPlannedSidecars(plan, createdPaths);

  const { companionPaths, movedCompanionSources, movedStackCompanion } = await carryCompanions(
    req,
    finalDest,
    createdPaths,
  );
  const replacing = req.carrySidecars !== false && replacesOccupants(req);
  await removeStaleDestinationSidecars(
    finalDest,
    plan,
    replacing && sourceSidecars.length === 0,
    replacing,
    createdPaths,
  );

  const stackSource = req.stackCompanion?.sourceAbsPath;
  const keepSource = await sourceSidecarStays(
    req.sourceAbsPath,
    finalDest,
    plan,
    [
      ...(req.extraCompanionAbsPaths ?? []),
      ...movedCompanionSources.filter((source) => source === stackSource),
    ],
    movedCompanionSources,
  );
  const movedSidecars = carried.map((entry) => ({
    ...entry,
    keepSource: keepSource && !entry.oldName,
  }));
  return {
    copiedSidecars,
    movedSidecars,
    companionPaths,
    movedCompanionSources,
    movedStackCompanion,
  };
}

/** Step 5: run the caller's identity-repoint hook (if any) between the
 * verified copy and the delete. Returns an error message on failure (after
 * reverting every copy made so far — the load-bearing failure-direction
 * guarantee) or `null` on success/absence. */
async function runIdentityRepoint(
  onVerified: RelocateRequest['onVerified'],
  info: RelocateVerifiedInfo,
  createdPaths: RelocatePublication[],
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

export async function relocateFile(req: RelocateRequest): Promise<RelocateOutcome> {
  return (await refuseSameFile(req)) ?? relocateWithCollisionRetry(req);
}

/** Same-file and case-only-rename handling, before any collision resolution. */
async function refuseSameFile(req: RelocateRequest): Promise<RelocateOutcome | null> {
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
    return caseOnlyCompanionRename(req.stackCompanion, req.destAbsPath).then(
      (companion) => performCaseOnlyRename(req, companion),
      errorOutcome,
    );
  }
  return null;
}

async function relocateWithCollisionRetry(req: RelocateRequest): Promise<RelocateOutcome> {
  const sidecars = await listRelocateSidecars(
    req.sourceAbsPath,
    req.stackCompanion,
    req.mode,
    req.carrySidecars,
  );
  if (sidecars === null) {
    return errorOutcome(new Error("relocate: the photo's old-name backup edit can't be read"));
  }
  for (let attempt = 0; ; attempt++) {
    try {
      return await relocateOnce(req, sidecars);
    } catch (err) {
      if (!(err instanceof PublishCollisionError)) return errorOutcome(err);
      if (isSuffixing(req.collision) && attempt < MAX_COLLISION_RETRIES) continue;
      return collisionOutcome(req, err);
    }
  }
}

const MAX_COLLISION_RETRIES = 8;

function errorOutcome(err: unknown): RelocateOutcome {
  return { kind: 'error', error: err instanceof Error ? err.message : String(err) };
}

/** A name taken mid-publish: a skip under `'skip'`, or for a stack JPEG that may not replace. */
function collisionOutcome(req: RelocateRequest, err: PublishCollisionError): RelocateOutcome {
  const companionSkips =
    err instanceof CompanionCollisionError && req.stackCompanion?.replace === false;
  return req.collision === 'skip' || companionSkips
    ? skippedAt(req, err.destination)
    : errorOutcome(err);
}

function skippedAt(req: RelocateRequest, collidedAt: string): RelocateOutcome {
  return { kind: 'skipped', reason: 'collision', ...(req.stackCompanion ? { collidedAt } : {}) };
}

/** One resolution + copy + delete pass. Throws `PublishCollisionError`
 * (after reverting its own copies) when another file holds a destination
 * name, so suffixing policies can retry the next free name. */
async function relocateOnce(
  req: RelocateRequest,
  sidecars: RelocateSidecars,
): Promise<RelocateOutcome> {
  // 1. Resolve the destination per the caller's collision policy.
  const resolution = await resolveDestination(req, sidecars);
  if (resolution.kind === 'skip') {
    return skippedAt(req, resolution.collidedAt);
  }
  const { finalDest } = resolution;
  await fs.mkdir(path.dirname(finalDest), { recursive: true });
  const execute = () => relocateResolved(req, finalDest, sidecars);
  const companion = req.stackCompanion?.sourceAbsPath;
  return replacesOccupants(req) && req.carrySidecars !== false
    ? withReplaceSidecarFence(
        req.sourceAbsPath,
        finalDest,
        req.mode,
        execute,
        companion ? [companion, stackCompanionTarget(finalDest, companion)] : [],
      )
    : execute();
}

async function relocateResolved(
  req: RelocateRequest,
  finalDest: string,
  sidecars: RelocateSidecars,
): Promise<RelocateOutcome> {
  const stackPlan = await stackCompanionSidecarPlan(
    req.stackCompanion,
    finalDest,
    sidecars.companion,
    isSuffixing(req.collision),
  );
  const plan = await planSidecars({
    sourceAbsPath: req.sourceAbsPath,
    finalDest,
    leavingWithPrimary: [...(req.extraCompanionAbsPaths ?? []), ...stackPlan.leaving],
    arrivingWithPrimary: stackPlan.arriving,
    companion: stackPlan.companion,
    replace: req.collision === 'replace',
    sourceSidecars: sidecars.primary,
  });

  const createdPaths: RelocatePublication[] = [];
  const progress = { repointed: false };
  try {
    return await copyRepointDelete(req, finalDest, sidecars, plan, createdPaths, progress);
  } catch (err) {
    if (!progress.repointed) await revertCreated(createdPaths);
    if (err instanceof PublishCollisionError && !progress.repointed) throw err;
    return errorOutcome(err);
  } finally {
    // A revert empties the list after restoring each displaced photo; what is
    // left belongs to a move that committed.
    await releaseDisplaced(createdPaths);
  }
}

/** Steps 2-6 for a resolved destination. `progress.repointed` tells the
 * caller whether a failure may still revert the copies. */
async function copyRepointDelete(
  req: RelocateRequest,
  finalDest: string,
  sidecars: RelocateSidecars,
  plan: SidecarPlan,
  createdPaths: RelocatePublication[],
  progress: { repointed: boolean },
): Promise<RelocateOutcome> {
  await req.onDestinationPrepared?.(finalDest);
  // 2-4. Copy + verify the primary, then carry the sidecars + any extra
  // companions (#2667) alongside.
  const {
    copiedSidecars,
    movedSidecars,
    companionPaths,
    movedCompanionSources,
    movedStackCompanion,
  } = await copyPrimaryAndSidecars(req, finalDest, sidecars.primary, plan, createdPaths);

  // 5. Identity repoint, between verify and delete.
  await req.beforeSourceDelete?.();
  const repointError = await runIdentityRepoint(
    req.onVerified,
    {
      newAbsPath: finalDest,
      sidecarPaths: copiedSidecars,
      companionPaths,
      companionSources: movedCompanionSources,
    },
    createdPaths,
  );
  if (repointError) return { kind: 'error', error: repointError };
  progress.repointed = req.onVerified !== undefined;

  // 6. Delete the originals — move mode only. The row now points at the new
  // path, so a sidecar created since the listing is carried too (#5062).
  if (req.mode === 'move') {
    const late =
      req.carrySidecars === false
        ? []
        : await carryLateSidecars({
            sourceAbsPath: req.sourceAbsPath,
            finalDest,
            listed: sidecars.primary,
            movedCompanions: movedCompanionSources,
            movedStackCompanion,
            companionListed: sidecars.companion,
            publications: createdPaths,
          });
    await deleteOriginals({
      sourceAbsPath: req.sourceAbsPath,
      movedTo: finalDest,
      carriesSidecars: req.carrySidecars !== false,
      movedSidecars: [...movedSidecars, ...late],
      movedCompanionSources,
      movedStackCompanion,
      beforeSourceDelete: req.beforeSourceDelete,
    });
  }

  return {
    kind: 'relocated',
    newAbsPath: finalDest,
    sidecarPaths: copiedSidecars,
    companionPaths,
    renamedOnCollision: finalDest !== req.destAbsPath,
  };
}
