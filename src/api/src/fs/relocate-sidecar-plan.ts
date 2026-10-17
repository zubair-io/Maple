import * as fs from './mirrored.ts';
import { sidecarRenameTarget } from './sidecar-rename.ts';
import { child as childLogger } from '../log.ts';
import {
  SidecarCollisionError,
  publishSidecarSnapshot,
  sameSidecarFile,
  sidecarAlreadyCarried,
  sidecarStemClaimedBySibling,
} from './sidecar-ownership.ts';

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
async function tryCopySidecar(sidecar: string, dest: string): Promise<Buffer | null> {
  try {
    return await publishSidecarSnapshot(sidecar, dest);
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
  createdPaths: string[],
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
      carried.push({
        source: entry.source,
        dest: entry.dest,
        snapshot: await fs.readFile(entry.dest),
      });
      continue;
    }
    if (entry.replacesOccupant) await fs.unlink(entry.dest).catch(() => {});
    const snapshot = await tryCopySidecar(entry.source, entry.dest);
    if (!snapshot) continue;
    createdPaths.push(entry.dest);
    copiedSidecars.push(entry.dest);
    carried.push({ source: entry.source, dest: entry.dest, snapshot });
  }
  return { copiedSidecars, carried };
}
