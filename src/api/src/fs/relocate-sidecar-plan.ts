import * as fs from './mirrored.ts';
import { sidecarRenameTarget } from './sidecar-rename.ts';
import { child as childLogger } from '../log.ts';
import { listPairedSidecars } from './xmp-conflict.ts';
import {
  isLegacyBackupSidecarOf,
  locateLegacyBackupEdit,
  oldNameEditUnlisted,
  oldNameEditUnreadable,
  oldNameSlotTaken,
} from './legacy-backup-sidecar.ts';
import {
  SidecarCollisionError,
  joinCarriedSidecar,
  publishSidecarSnapshot,
  sameSidecarFile,
  sidecarAlreadyCarried,
  sidecarStemClaimedBySibling,
  publishConflictBytes,
} from './sidecar-ownership.ts';
import type { RelocatePublication } from './relocate-publish.ts';
import { readSidecarBytes } from './sidecar-bytes.ts';
import { serializeSidecarWrite } from './sidecar-write-order.ts';

export interface SidecarPlanEntry {
  source: string;
  dest: string;
  samePath: boolean;
  /** `dest` already holds identical bytes: the photo joins it, no copy. */
  joinsCarried: boolean;
  replacesOccupant: boolean;
  /** A pre-#5021 old-name edit: one that fails to copy fails the move (#5063). */
  oldName: boolean;
  /** The displaced old-name edit this one takes over, with the bytes the plan read. */
  takesOver: DisplacedEdit | null;
}

export interface SidecarPlan {
  entries: SidecarPlanEntry[];
  sourceClaimedBySibling: boolean;
  destinationClaimedBySibling: boolean;
  /** A photo sat at the destination before the move, so Replace displaces one. */
  destinationHadPrimary: boolean;
  /** The displaced photo's old-name edits, every spelling but one the incoming edit lands on;
   * removed once the new photo is in place while unchanged since the plan, so it is
   * never read as the new photo's. */
  staleDisplacedOldNames: readonly { legacy: string; bytes: Buffer }[];
  replace: boolean;
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

/** Where a carried old-name edit (#5063) may land. Replace takes over only the
 * displaced photo's Maple old-name edit; another tool's file, a name another
 * file there owns, or a stranded edit with no photo keeps it at the source. */
async function oldNameEditLands(
  req: SidecarPlanRequest,
  dest: string,
  occupied: boolean,
  displacedOldName: string | null,
): Promise<boolean> {
  // Any case spelling; on a case-sensitive volume a file at the exact name must be that edit.
  if (displacedOldName !== null) return !occupied || sameSidecarFile(displacedOldName, dest);
  return !occupied && !(await oldNameSlotTaken(req.finalDest));
}

interface EntryState {
  samePath: boolean;
  occupied: boolean;
  joinsCarried: boolean;
}

type Fate = 'carry' | 'stay' | 'collide';
type DestinationState = {
  claimedBySibling: boolean;
  /** Replace's displaced photo's old-name edit, as stored, with the bytes the plan read. */
  displaced: DisplacedEdit | null;
};

type DisplacedEdit = { legacy: string; bytes: Buffer };

function sidecarFate(
  req: SidecarPlanRequest,
  state: EntryState,
  destination: DestinationState,
): Fate {
  const blocked = !req.replace || destination.claimedBySibling;
  return state.occupied && !state.joinsCarried && blocked ? 'collide' : 'carry';
}

/** An old-name edit that can't land stays behind under Replace and collides
 * otherwise, so auto-suffix tries the next name. */
async function oldNameFate(
  req: SidecarPlanRequest,
  dest: string,
  state: EntryState,
  destination: DestinationState,
): Promise<Fate> {
  if (state.samePath || state.joinsCarried) return 'carry';
  if (await oldNameEditLands(req, dest, state.occupied, destination.displaced?.legacy ?? null)) {
    return 'carry';
  }
  return req.replace ? 'stay' : 'collide';
}

/** Replace retires the displaced photo's old-name edit (#5063), or the
 * incoming photo's own takes it over. One that can't be read would survive and
 * later be read as the incoming photo's, so the move is refused before any byte moves. */
async function displacedOldNameEdits(
  req: SidecarPlanRequest,
): Promise<{ legacy: string; bytes: Buffer }[]> {
  if (await oldNameEditUnreadable(req.finalDest)) {
    throw new Error("relocate: the displaced photo's old-name backup edit can't be read");
  }
  // Every spelling a case- or normalization-sensitive volume holds, first one first.
  const found: { legacy: string; bytes: Buffer }[] = [];
  for (;;) {
    const skip = new Set(found.map((edit) => edit.legacy));
    const next = await locateLegacyBackupEdit(req.finalDest, skip).catch(() => null);
    if (next === null) return found;
    found.push(next);
  }
}

async function entryState(source: string, dest: string): Promise<EntryState> {
  const samePath = await sameSidecarFile(source, dest);
  const occupied = !samePath && (await exists(dest));
  const joinsCarried = occupied && (await sidecarAlreadyCarried(source, dest));
  return { samePath, occupied, joinsCarried };
}

/** One sidecar's plan; `null` leaves it at the source. */
async function planEntry(
  req: SidecarPlanRequest,
  source: string,
  destination: DestinationState,
): Promise<SidecarPlanEntry | null> {
  const dest = sidecarRenameTarget(req.sourceAbsPath, req.finalDest, source);
  if (!dest) return null; // defensive — mirrors moveSidecarsAlongside
  const state = await entryState(source, dest);
  const { samePath, occupied, joinsCarried } = state;
  const oldName = isLegacyBackupSidecarOf(req.sourceAbsPath, source);
  const fate = oldName
    ? await oldNameFate(req, dest, state, destination)
    : sidecarFate(req, state, destination);
  if (fate === 'collide') throw new SidecarCollisionError(dest);
  if (fate === 'stay') return null;
  const replacesOccupant = occupied && !joinsCarried;
  const takesOver = oldName && replacesOccupant ? destination.displaced : null;
  return { source, dest, samePath, joinsCarried, replacesOccupant, oldName, takesOver };
}

/** The sidecars that travel with the photo, or `null` when its old-name edit
 * can't be read: moving without it would leave it behind with no photo. */
export async function ownSidecarsOf(
  sourceAbsPath: string,
  mode: 'move' | 'copy',
  carrySidecars: boolean | undefined,
): Promise<readonly string[] | null> {
  if (carrySidecars === false) return [];
  const listed = await listPairedSidecars(sourceAbsPath);
  // A copy leaves the source's edits where they are, so nothing is stranded.
  if (mode !== 'move') return listed;
  return (await oldNameEditUnlisted(sourceAbsPath, listed)) ? null : listed;
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
  const destinationHadPrimary = await exists(req.finalDest);
  const displacedOldNames =
    req.replace && destinationHadPrimary ? await displacedOldNameEdits(req) : [];
  const displacedOldName = displacedOldNames[0] ?? null;
  const entries: SidecarPlanEntry[] = [];
  for (const source of req.sourceSidecars) {
    const entry = await planEntry(req, source, {
      claimedBySibling: destinationClaimedBySibling,
      displaced: displacedOldName,
    });
    if (entry) entries.push(entry);
  }
  const incomingOldName = entries.find((entry) => entry.oldName);
  const takenOver =
    incomingOldName !== undefined &&
    displacedOldName !== null &&
    (await sameSidecarFile(displacedOldName.legacy, incomingOldName.dest));
  return {
    entries,
    sourceClaimedBySibling,
    destinationClaimedBySibling,
    destinationHadPrimary,
    staleDisplacedOldNames: takenOver ? displacedOldNames.slice(1) : displacedOldNames,
    replace: req.replace,
  };
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

/** An old-name edit left behind is never found again (#5063), so its copy
 * failure fails the move, unless Replace has already displaced the occupant
 * (a rollback would lose it) or the file is gone (the migration took it). */
async function oldNameCopyFatal(entry: SidecarPlanEntry, replace: boolean): Promise<boolean> {
  if (!entry.oldName || replace) return false;
  return fs.lstat(entry.source).then(
    () => true,
    () => false,
  );
}

/** Best-effort copy of one sidecar — a failure is logged and the original
 * left in place; only a collision, or an old-name edit that can still be
 * carried, aborts the whole asset. */
async function tryCopySidecar(
  entry: SidecarPlanEntry,
  createdPaths: RelocatePublication[],
  replace: boolean,
): Promise<Buffer | null> {
  const { source: sidecar, dest } = entry;
  try {
    return await publishSidecarSnapshot(sidecar, dest, createdPaths);
  } catch (err) {
    if (err instanceof SidecarCollisionError || (await oldNameCopyFatal(entry, replace))) throw err;
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
    if (entry.takesOver) {
      // A displaced edit that can't be retired stays, and the incoming one with it.
      if (!(await retireDisplaced(entry.takesOver))) continue;
    } else if (entry.replacesOccupant) {
      await fs.unlink(entry.dest).catch(() => {});
    }
    const snapshot = await tryCopySidecar(entry, createdPaths, plan.replace);
    if (!snapshot) continue;
    copiedSidecars.push(entry.dest);
    carried.push({ source: entry.source, dest: entry.dest, snapshot });
  }
  return { copiedSidecars, carried };
}

/** Retire a displaced photo's old-name edit (#5063) under its barrier. Bytes
 * saved since the plan read it are the old photo's newer edit: they land as a
 * `(conflict from move)` copy, which the migration never adopts, so they are
 * neither lost nor read as the incoming photo's. False when it had to stay. */
async function retireDisplaced(displaced: DisplacedEdit): Promise<boolean> {
  const { legacy, bytes } = displaced;
  return serializeSidecarWrite(legacy, async () => {
    const now = await readSidecarBytes(legacy);
    if (now === null) return true;
    const photo = legacy.slice(0, -'.xmp'.length);
    if (!now.equals(bytes) && !(await publishConflictBytes(photo, now))) {
      throw new Error(`relocate: no free conflict name beside ${photo}`);
    }
    await fs.unlink(legacy);
    return true;
  }).catch((err: unknown) => {
    log.error(
      { legacy, err: err instanceof Error ? err.message : err },
      "relocate: the displaced photo's old-name edit couldn't be retired — kept",
    );
    return false;
  });
}

/** An incoming asset with no sidecar under `'replace'` means "the destination
 * now reflects EXACTLY the incoming asset" — a stale sidecar left over from
 * the PREVIOUS occupant must not silently survive and get misattributed to
 * this one (#2633 parity harness). A sidecar another same-stem photo there
 * still uses is not stale (#4692). The displaced photo's old-name edit is
 * stale whatever the incoming photo brings, unless its own took it over (#5063).
 * Only runs AFTER the new primary published. */
export async function removeStaleDestinationSidecars(
  finalDest: string,
  plan: SidecarPlan,
  replacesWithoutSidecar: boolean,
  replacing: boolean,
): Promise<void> {
  if (replacing) {
    for (const stale of plan.staleDisplacedOldNames) await retireDisplaced(stale);
  }
  if (!replacesWithoutSidecar || plan.destinationClaimedBySibling) return;
  for (const stale of await listPairedSidecars(finalDest)) {
    // Old-name edits (#5063) are handled above: a displaced one only while unchanged, a stranded one never.
    if (isLegacyBackupSidecarOf(finalDest, stale)) continue;
    await fs.unlink(stale).catch(() => {});
  }
}
