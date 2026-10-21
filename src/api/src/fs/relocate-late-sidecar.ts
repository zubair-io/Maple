/**
 * Relocate's second listing (#5062): sidecars that appeared at the source
 * after the move listed them are carried once the row is repointed.
 */
import * as path from 'node:path';
import { child as childLogger } from '../log.ts';
import { isLegacyBackupSidecarOf, oldNameSlotTaken } from './legacy-backup-sidecar.ts';
import type { MovedSidecar } from './relocate-sidecar-plan.ts';
import type { RelocatePublication } from './relocate-publish.ts';
import { sidecarRenameTarget } from './sidecar-rename.ts';
import {
  SidecarCollisionError,
  joinCarriedSidecar,
  publishSidecarSnapshot,
  sameSidecarFile,
  sidecarAlreadyCarried,
  sidecarStemClaimedBySibling,
} from './sidecar-ownership.ts';
import { listPairedSidecars, pickFreeConflictPath } from './xmp-conflict.ts';

const log = childLogger('fs/relocate');

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

/** An old-name edit (#5063) whose slot is taken or owned at the destination
 * lands as a conflict copy, unless that slot already holds the same bytes. */
async function publishNewcomer(
  source: string,
  dest: string,
  oldName: boolean,
  carry: LateCarry,
): Promise<{ dest: string; snapshot: Buffer } | null> {
  const slotTaken =
    oldName &&
    (await oldNameSlotTaken(carry.finalDest)) &&
    !(await sidecarAlreadyCarried(source, dest));
  const publish = slotTaken
    ? publishLateConflict(source, carry)
    : publishLateSidecar(source, dest, carry);
  return publish.catch((err: unknown) => {
    log.warn(
      { source, dest, err: err instanceof Error ? err.message : err },
      'relocate: sidecar created mid-move left in place',
    );
    return null;
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
    const oldName = isLegacyBackupSidecarOf(sourceAbsPath, source);
    const published = await publishNewcomer(source, dest, oldName, carry);
    if (published) moved.push({ source, ...published, keepSource: keepSource && !oldName });
  }
  return moved;
}
