/**
 * A RAW+JPEG stack's JPEG relocated with its RAW in one `relocateFile` call
 * (#5929, #5930): it lands under the RAW's final stem with its own extension,
 * its name counts whenever a collision policy picks or checks the destination,
 * and failing to place it reverts the whole relocate, which puts back whatever
 * a Replace displaced. Nothing is released until both files have committed.
 */
import * as path from 'node:path';
import * as fs from './mirrored.ts';
import { errnoCode } from './errno-code.ts';
import {
  isLegacyBackupSidecarOf,
  locateLegacyBackupEdit,
  oldNameSlotTaken,
} from './legacy-backup-sidecar.ts';
import { classifySameFile } from './relocate-case-only-rename.ts';
import {
  PublishCollisionError,
  copyVerifiedIntoPlace,
  type RelocatePublication,
} from './relocate-publish.ts';
import { sameSidecarFile, sidecarAlreadyCarried } from './sidecar-ownership.ts';
export interface StackCompanionRequest {
  sourceAbsPath: string;
  /** Replace a file holding the JPEG's destination name; otherwise that name is a collision. */
  replace: boolean;
}

/** Where the JPEG goes when its RAW lands at `rawDest`. */
export function stackCompanionTarget(rawDest: string, companion: string): string {
  return path.join(path.dirname(rawDest), path.parse(rawDest).name + path.extname(companion));
}

/** The JPEG's destination name was taken: the pair skips or collides as a whole. */
export class CompanionCollisionError extends PublishCollisionError {
  constructor(destination: string) {
    super(destination, `relocate: the stack's JPEG name is taken: ${destination}`);
    this.name = 'CompanionCollisionError';
  }
}

/** Sidecars listed at the RAW and its stack JPEG. */
export interface RelocateSidecars {
  primary: readonly string[];
  companion: readonly string[];
}

/** Merge any stem-paired sidecar of the JPEG that the RAW's listing missed
 * (a differently cased UUID branch) into the RAW's sidecar list. */
export function mergeCompanionStemSidecars(
  primarySidecars: readonly string[],
  companion: StackCompanionRequest | undefined,
  companionSidecars: readonly string[],
): readonly string[] {
  if (!companion || companionSidecars.length === 0) return primarySidecars;
  const known = new Set(primarySidecars.map((s) => path.resolve(s)));
  const extra = companionSidecars.filter(
    (s) => !isLegacyBackupSidecarOf(companion.sourceAbsPath, s) && !known.has(path.resolve(s)),
  );
  return extra.length === 0 ? primarySidecars : [...primarySidecars, ...extra];
}

/** Whether a file other than the JPEG itself holds the JPEG's name or its
 * old-name backup edit slot beside `candidate`. */
export async function companionNameTaken(
  companion: StackCompanionRequest | undefined,
  candidate: string,
  companionSidecars: readonly string[] = [],
  carrySidecars = true,
): Promise<boolean> {
  if (!companion) return false;
  const target = stackCompanionTarget(candidate, companion.sourceAbsPath);
  if ((await classifySameFile(companion.sourceAbsPath, target)) !== 'different') return false;
  const present = await fs.lstat(target).then(
    () => true,
    (err: unknown) => errnoCode(err) !== 'ENOENT',
  );
  if (present || !carrySidecars) return present;
  return companionLegacySidecarTaken(companion.sourceAbsPath, target, companionSidecars);
}

async function companionLegacySidecarTaken(
  sourceAbsPath: string,
  target: string,
  companionSidecars: readonly string[],
): Promise<boolean> {
  const ownLegacy = companionSidecars.find((s) => isLegacyBackupSidecarOf(sourceAbsPath, s));
  const atTarget = await locateLegacyBackupEdit(target).catch(() => 'unreadable' as const);
  if (atTarget === 'unreadable') return true;
  if (atTarget !== null) {
    if (ownLegacy && (await sameSidecarFile(ownLegacy, atTarget.legacy))) return false;
    return !(ownLegacy && (await sidecarAlreadyCarried(ownLegacy, atTarget.legacy)));
  }
  return ownLegacy !== undefined && oldNameSlotTaken(target);
}

/** The JPEG's sidecar-plan inputs when it leaves its place with the RAW. */
export async function stackCompanionSidecarPlan(
  companion: StackCompanionRequest | undefined,
  finalDest: string,
  companionSidecars: readonly string[],
  suffixing: boolean,
): Promise<{
  leaving: string[];
  arriving: string[];
  companion?: {
    sourceAbsPath: string;
    finalDest: string;
    replace: boolean;
    sourceSidecars: readonly string[];
  };
}> {
  if (!companion) return { leaving: [], arriving: [] };
  const target = stackCompanionTarget(finalDest, companion.sourceAbsPath);
  const leaving =
    (await classifySameFile(companion.sourceAbsPath, target)) === 'identical'
      ? []
      : [companion.sourceAbsPath];
  return {
    leaving,
    arriving: [target],
    ...(leaving.length > 0
      ? {
          companion: {
            sourceAbsPath: companion.sourceAbsPath,
            finalDest: target,
            replace: !suffixing && companion.replace,
            sourceSidecars: companionSidecars,
          },
        }
      : {}),
  };
}
/** Publish the JPEG beside the RAW's `finalDest`, recording it for a rollback.
 * `null` when it already sits there. Throws when it cannot land, which reverts
 * the relocate. */
export async function carryStackCompanion(
  companion: StackCompanionRequest | undefined,
  finalDest: string,
  createdPaths: RelocatePublication[],
): Promise<string | null> {
  if (!companion) return null;
  const target = stackCompanionTarget(finalDest, companion.sourceAbsPath);
  const same = await classifySameFile(companion.sourceAbsPath, target);
  if (same === 'identical') return null;
  if (same === 'case-only-rename') {
    throw new Error(`relocate: the stack's JPEG name would change only in case: ${target}`);
  }
  try {
    await copyVerifiedIntoPlace(companion.sourceAbsPath, target, companion.replace, createdPaths);
  } catch (err) {
    throw err instanceof PublishCollisionError ? new CompanionCollisionError(target) : err;
  }
  return target;
}

/** The JPEG's rename when its RAW's is case-only (#2704): `null` when its name
 * stays. Throws when it would need more than a case change. */
export async function caseOnlyCompanionRename(
  companion: StackCompanionRequest | undefined,
  rawDest: string,
): Promise<{ from: string; to: string } | null> {
  if (!companion) return null;
  const to = stackCompanionTarget(rawDest, companion.sourceAbsPath);
  const same = await classifySameFile(companion.sourceAbsPath, to);
  if (same === 'identical') return null;
  if (same === 'case-only-rename') return { from: companion.sourceAbsPath, to };
  throw new Error(`relocate: the stack's JPEG cannot follow a case-only rename to ${to}`);
}
