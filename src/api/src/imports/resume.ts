/**
 * Import steps that decide a group without copying its primary: the duplicate
 * probe, finding the group an earlier attempt stopped in, and finishing a group
 * whose primary has already landed (a retry, or an attempt that took the import
 * over).
 */

import type { ImportFileEntry } from '../db/schema.ts';
import { destAbsPath, resolveDest } from './copy.ts';
import type { ClaimedImport } from './repo.ts';

export type RecordFile = (
  index: number,
  state: ImportFileEntry['state'],
  error: string | null,
  destRel: string,
) => Promise<void>;

export interface CopyOutcome {
  state: ImportFileEntry['state'];
  error: string | null;
  destRel: string;
}

export interface DuplicateProbeDeps {
  hashFileForId: (src: string) => Promise<{ maple_id: string; sha1_head: string }>;
  assetExistsForHash: (mapleId: string, sha1Head: string) => Promise<boolean>;
}

/** A hash failure (unreadable source) is returned as `error` and fails just this group. */
export async function probeDuplicate(
  deps: DuplicateProbeDeps,
  primary: ImportFileEntry,
): Promise<{ isDuplicate: boolean; error: string | null }> {
  if (primary.kind !== 'image') return { isDuplicate: false, error: null };
  try {
    const h = await deps.hashFileForId(primary.src);
    const isDuplicate = await deps.assetExistsForHash(h.maple_id, h.sha1_head);
    return { isDuplicate, error: null };
  } catch (err) {
    return { isDuplicate: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * The group an earlier attempt of this import stopped in, for an attempt that
 * took the import over. Groups are recorded whole and in order, so it is the
 * first one that still holds a pending row. If that attempt stopped between two
 * groups, this is the next, untouched group: nothing recorded tells the two
 * cases apart. An Auto Import still waiting for its scan has copied nothing.
 */
export function findInterruptedGroup(
  claim: Pick<ClaimedImport, 'taken_over' | 'scan_pending'>,
  files: ImportFileEntry[],
  primaries: number[],
  sidecars: Map<number, number[]>,
): number | undefined {
  if (!claim.taken_over || claim.scan_pending) return undefined;
  return primaries.find((pIdx) =>
    [pIdx, ...(sidecars.get(pIdx) ?? [])].some((index) => files[index].state === 'pending'),
  );
}

/** True when the file's own destination already holds its exact bytes. */
export async function inPlace(libraryRoot: string, file: ImportFileEntry): Promise<boolean> {
  try {
    return (await resolveDest(libraryRoot, file.dest, file.src)).alreadyPresent;
  } catch {
    return false;
  }
}

export interface ResumeSeams {
  copyOne: (
    libraryRoot: string,
    src: string,
    destRel: string,
    keepExisting?: boolean,
  ) => Promise<CopyOutcome>;
  handOffToIndexer: (absPath: string) => Promise<void>;
  rearmSidecarIndex: (imageFilename: string) => Promise<void>;
}

async function placeInterruptedSidecar(
  libraryRoot: string,
  sidecar: ImportFileEntry,
  seams: ResumeSeams,
): Promise<CopyOutcome> {
  const outcome = await seams.copyOne(libraryRoot, sidecar.src, sidecar.dest, true);
  const landedEarlier =
    outcome.state === 'skipped_duplicate' && (await inPlace(libraryRoot, sidecar));
  return landedEarlier ? { ...outcome, state: 'copied' } : outcome;
}

/**
 * Copies the still-pending sidecars of an already-landed primary and re-records
 * everything else unchanged. When a sidecar newly lands next to an image the
 * library already indexed, the image is handed to the indexer again and its
 * sidecar-metadata index is re-armed, because that stage may already have
 * settled on "no sidecar" for it.
 *
 * `interrupted` marks the group an earlier attempt stopped in. That attempt may
 * have put files in place without recording them and never reached the indexer
 * hand-off, so a pending sidecar already in place counts as copied and the
 * image is always handed over. The primary may also be one that attempt found
 * rather than copied, so a different sidecar already beside it is left alone
 * and reported as skipped.
 */
export async function resumeLandedPrimary(args: {
  libraryRoot: string;
  files: ImportFileEntry[];
  primaryIndex: number;
  sidecarIndexes: number[];
  record: RecordFile;
  interrupted: boolean;
  seams: ResumeSeams;
}): Promise<void> {
  const { libraryRoot, files, primaryIndex, sidecarIndexes, record, interrupted, seams } = args;
  const primary = files[primaryIndex];
  await record(primaryIndex, 'copied', null, primary.dest);

  let newlyCopied = 0;
  for (const sIdx of sidecarIndexes) {
    const sidecar = files[sIdx];
    if (sidecar.state !== 'pending') {
      await record(sIdx, sidecar.state, sidecar.error, sidecar.dest);
      continue;
    }
    const r = interrupted
      ? await placeInterruptedSidecar(libraryRoot, sidecar, seams)
      : await seams.copyOne(libraryRoot, sidecar.src, sidecar.dest);
    if (r.state === 'copied') newlyCopied += 1;
    await record(sIdx, r.state, r.error, r.destRel);
  }

  if (primary.kind === 'image' && (interrupted || newlyCopied > 0)) {
    await seams.handOffToIndexer(destAbsPath(libraryRoot, primary.dest));
    await seams.rearmSidecarIndex(primary.dest.split('/').pop() ?? primary.dest);
  }
}
