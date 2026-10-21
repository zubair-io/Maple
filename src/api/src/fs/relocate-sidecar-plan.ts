import * as fs from './mirrored.ts';
import * as path from 'node:path';
import { sidecarRenameTarget } from './sidecar-rename.ts';
import { child as childLogger } from '../log.ts';
import { listPairedSidecars, pickFreeConflictPath } from './xmp-conflict.ts';
import {
  SidecarCollisionError,
  joinCarriedSidecar,
  publishSidecarSnapshot,
  sameSidecarFile,
  sidecarAlreadyCarried,
  sidecarStemClaimedBySibling,
} from './sidecar-ownership.ts';
import type { RelocatePublication } from './relocate-publish.ts';

export interface SidecarPlanEntry {
  source: string;
  dest: string;
  samePath: boolean;
  /** `dest` already holds identical bytes: the photo joins it, no copy. */
  joinsCarried: boolean;
  replacesOccupant: boolean;
}

export interface SidecarPlan {
  entries: SidecarPlanEntry[];
  sourceClaimedBySibling: boolean;
  destinationClaimedBySibling: boolean;
}

export interface MovedSidecar {
  source: string;
  dest: string;
  snapshot: Buffer;
  keepSource: boolean;
}

export interface SidecarPlanRequest {
  sourceAbsPath: string;
  finalDest: string;
  /** Companions relocating with the primary — they stop claiming its stem. */
  leavingWithPrimary: readonly string[];
  replace: boolean;
  sourceSidecars: readonly string[];
}

async function exists(p: string): Promise<boolean> {
  return fs.lstat(p).then(
    () => true,
    () => false,
  );
}

/** Decide every sidecar's fate before any byte moves (#4692): a destination
 * sidecar that would be replaced must not belong to another photo there, and
 * a non-replace collision fails the whole asset before the primary lands. */
export async function planSidecars(req: SidecarPlanRequest): Promise<SidecarPlan> {
  const sourceClaimedBySibling = await sidecarStemClaimedBySibling(req.sourceAbsPath, [
    req.finalDest,
    ...req.leavingWithPrimary,
  ]);
  const destinationClaimedBySibling = await sidecarStemClaimedBySibling(req.finalDest, [
    req.sourceAbsPath,
  ]);
  const entries: SidecarPlanEntry[] = [];
  for (const source of req.sourceSidecars) {
    const dest = sidecarRenameTarget(req.sourceAbsPath, req.finalDest, source);
    if (!dest) continue; // defensive — mirrors moveSidecarsAlongside
    const samePath = await sameSidecarFile(source, dest);
    const occupied = !samePath && (await exists(dest));
    const joinsCarried = occupied && (await sidecarAlreadyCarried(source, dest));
    if (occupied && !joinsCarried && (!req.replace || destinationClaimedBySibling)) {
      throw new SidecarCollisionError(dest);
    }
    entries.push({
      source,
      dest,
      samePath,
      joinsCarried,
      replacesOccupant: occupied && !joinsCarried,
    });
  }
  return { entries, sourceClaimedBySibling, destinationClaimedBySibling };
}

export interface LateCarry {
  sourceAbsPath: string;
  finalDest: string;
  listed: readonly string[];
  movedCompanions: readonly string[];
  /** The move's rollback list: a late publication is withdrawn with the rest. */
  publications: RelocatePublication[];
}

const LATE_CONFLICT_ATTEMPTS = 5;

/** Another writer can take the picked conflict name first; pick again. */
async function publishLateConflict(
  source: string,
  carry: LateCarry,
): Promise<{ dest: string; snapshot: Buffer }> {
  for (let attempt = 0; attempt < LATE_CONFLICT_ATTEMPTS; attempt++) {
    const conflict = await pickFreeConflictPath(carry.finalDest, 'move');
    const snapshot = await publishSidecarSnapshot(source, conflict, carry.publications).catch(
      (err: unknown) => {
        if (err instanceof SidecarCollisionError) return null;
        throw err;
      },
    );
    if (snapshot) return { dest: conflict, snapshot };
  }
  throw new Error(`relocate: no free conflict name for ${carry.finalDest}`);
}

/** A newcomer whose own name is taken lands beside the photo as
 * `<stem> (conflict from move).xmp`, never stranded with no photo; one whose
 * destination already holds the same bytes joins it. */
async function publishLateSidecar(
  source: string,
  dest: string,
  carry: LateCarry,
): Promise<{ dest: string; snapshot: Buffer }> {
  try {
    return { dest, snapshot: await publishSidecarSnapshot(source, dest, carry.publications) };
  } catch (err) {
    if (!(err instanceof SidecarCollisionError)) throw err;
    const joined = (await sidecarAlreadyCarried(source, dest))
      ? await joinCarriedSidecar(source, dest).catch((joinErr: unknown) => {
          // The destination changed before the join's re-check: fall through to a conflict copy.
          if (joinErr instanceof SidecarCollisionError) return null;
          throw joinErr;
        })
      : null;
    if (joined) return { dest, snapshot: joined };
    return publishLateConflict(source, carry);
  }
}

/** Sidecars that appeared at the source after the move listed them (#5062),
 * such as a first backup send or web save landing mid-move. Carried the same
 * exclusive way; one that can't be published stays at the source. Never
 * throws: the move has already been repointed. */
export async function carryLateSidecars(carry: LateCarry): Promise<MovedSidecar[]> {
  return carryNewcomers(carry).catch((err: unknown) => {
    log.warn(
      { err: err instanceof Error ? err.message : err },
      'relocate: re-listing sidecars after the repoint failed',
    );
    return [];
  });
}

async function carryNewcomers(carry: LateCarry): Promise<MovedSidecar[]> {
  const { sourceAbsPath, finalDest } = carry;
  const known = new Set(carry.listed.map((sidecar) => path.resolve(sidecar)));
  const late = (await listPairedSidecars(sourceAbsPath)).filter(
    (sidecar) => !known.has(path.resolve(sidecar)),
  );
  if (late.length === 0) return [];
  const keepSource = await sidecarStemClaimedBySibling(sourceAbsPath, [
    finalDest,
    ...carry.movedCompanions,
  ]);
  const moved: MovedSidecar[] = [];
  for (const source of late) {
    const dest = sidecarRenameTarget(sourceAbsPath, finalDest, source);
    // An extension-only rename maps a sidecar onto itself: it already belongs to the photo.
    if (!dest || (await sameSidecarFile(source, dest))) continue;
    const published = await publishLateSidecar(source, dest, carry).catch((err: unknown) => {
      log.warn(
        { source, dest, err: err instanceof Error ? err.message : err },
        'relocate: sidecar created mid-move left in place',
      );
      return null;
    });
    if (published) moved.push({ source, ...published, keepSource });
  }
  return moved;
}

/** A companion that failed to copy still sits at the source and still claims
 * the stem, so ownership is re-checked against what actually moved. */
export async function sourceSidecarStays(
  sourceAbsPath: string,
  finalDest: string,
  plan: SidecarPlan,
  requestedCompanions: readonly string[],
  movedCompanions: readonly string[],
): Promise<boolean> {
  if (plan.sourceClaimedBySibling) return true;
  if (movedCompanions.length === requestedCompanions.length) return false;
  return sidecarStemClaimedBySibling(sourceAbsPath, [finalDest, ...movedCompanions]);
}

const log = childLogger('fs/relocate');

/** Best-effort copy of one sidecar — a failure is logged and the original
 * left in place; only a collision aborts the whole asset. */
async function tryCopySidecar(
  sidecar: string,
  dest: string,
  createdPaths: RelocatePublication[],
): Promise<Buffer | null> {
  try {
    return await publishSidecarSnapshot(sidecar, dest, createdPaths);
  } catch (err) {
    if (err instanceof SidecarCollisionError) throw err;
    log.warn(
      { sidecar, dest, err: err instanceof Error ? err.message : err },
      'relocate: sidecar copy failed — original left in place',
    );
    return null;
  }
}

/** Carry every planned sidecar to its destination, recording each path it
 * creates as it lands so a later throw can revert exactly what exists. */
export async function carryPlannedSidecars(
  plan: SidecarPlan,
  createdPaths: RelocatePublication[],
): Promise<{ copiedSidecars: string[]; carried: Omit<MovedSidecar, 'keepSource'>[] }> {
  const copiedSidecars: string[] = [];
  const carried: Omit<MovedSidecar, 'keepSource'>[] = [];
  for (const entry of plan.entries) {
    if (entry.samePath) {
      copiedSidecars.push(entry.dest);
      continue;
    }
    if (entry.joinsCarried) {
      copiedSidecars.push(entry.dest);
      const snapshot = await joinCarriedSidecar(entry.source, entry.dest);
      carried.push({ source: entry.source, dest: entry.dest, snapshot });
      continue;
    }
    if (entry.replacesOccupant) await fs.unlink(entry.dest).catch(() => {});
    const snapshot = await tryCopySidecar(entry.source, entry.dest, createdPaths);
    if (!snapshot) continue;
    copiedSidecars.push(entry.dest);
    carried.push({ source: entry.source, dest: entry.dest, snapshot });
  }
  return { copiedSidecars, carried };
}

/** An incoming asset with no sidecar under `'replace'` means "the destination
 * now reflects EXACTLY the incoming asset" — a stale sidecar left over from
 * the PREVIOUS occupant must not silently survive and get misattributed to
 * this one (#2633 parity harness). A sidecar another same-stem photo there
 * still uses is not stale (#4692). Only runs AFTER the new primary published. */
export async function removeStaleDestinationSidecars(
  finalDest: string,
  plan: SidecarPlan,
  replacesWithoutSidecar: boolean,
): Promise<void> {
  if (!replacesWithoutSidecar || plan.destinationClaimedBySibling) return;
  for (const stale of await listPairedSidecars(finalDest)) {
    await fs.unlink(stale).catch(() => {});
  }
}
