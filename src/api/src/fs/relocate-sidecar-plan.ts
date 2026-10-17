import * as fs from './mirrored.ts';
import { sidecarRenameTarget } from './sidecar-rename.ts';
import {
  SidecarCollisionError,
  sameSidecarFile,
  sidecarStemClaimedBySibling,
} from './sidecar-ownership.ts';

export interface SidecarPlanEntry {
  source: string;
  dest: string;
  samePath: boolean;
  replacesOccupant: boolean;
}

export interface SidecarPlan {
  entries: SidecarPlanEntry[];
  sourceClaimedBySibling: boolean;
  destinationClaimedBySibling: boolean;
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
    if (occupied && (!req.replace || destinationClaimedBySibling)) {
      throw new SidecarCollisionError(dest);
    }
    entries.push({ source, dest, samePath, replacesOccupant: occupied });
  }
  return { entries, sourceClaimedBySibling, destinationClaimedBySibling };
}
