/**
 * Import steps that decide a group without copying its primary: the duplicate
 * probe, and finishing a group whose primary has already landed (a retry, or a
 * group an earlier attempt started and did not finish).
 */

import type { ImportFileEntry } from '../db/schema.ts';
import { destAbsPath } from './copy.ts';
import { publishFile, type CopyOutcome } from './publish.ts';
import { renamedSidecars, sidecarDestsBeside, type SidecarDest } from './sidecar-dest.ts';

export type RecordFile = (
  index: number,
  state: ImportFileEntry['state'],
  error: string | null,
  destRel: string,
  sidecarDests?: SidecarDest[],
) => Promise<void>;

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

export interface ResumeSeams {
  markPublishing: (index: number, destRel: string) => Promise<void>;
  handOffToIndexer: (absPath: string) => Promise<void>;
  rearmSidecarIndex: (imageFilename: string) => Promise<void>;
}

async function placeInterruptedSidecar(
  libraryRoot: string,
  src: string,
  destRel: string,
): Promise<CopyOutcome> {
  const outcome = await publishFile(libraryRoot, src, destRel, { keepExisting: true });
  return outcome.alreadyPresent ? { ...outcome, state: 'copied' } : outcome;
}

/**
 * Copies the still-pending sidecars of a primary that is already at
 * `landedDest` and re-records everything else with its outcome unchanged. When
 * the primary landed under a new name, every sidecar row that is not copied
 * takes the name beside it, a failed one included: a later retry copies a
 * failed sidecar to the destination its row names, and the old name is beside
 * a different image. When a sidecar newly lands next to an image the library
 * already indexed, the image is handed to the indexer again and its
 * sidecar-metadata index is re-armed, because that stage may already have
 * settled on "no sidecar" for it.
 *
 * `interrupted` marks a group an earlier attempt started: its primary carried a
 * publish marker. That attempt may have put sidecars in place without recording
 * them and never reached the indexer hand-off, so a pending sidecar already in
 * place counts as copied and the image is always handed over. The image may
 * have been catalogued and edited since, so a different sidecar already beside
 * it is left alone and reported as skipped.
 *
 * A group picked up without a marker (a retry of a failed sidecar) is marked
 * here before any sidecar is copied, so a stop before its hand-off is seen by
 * the next attempt the same way.
 */
export async function resumeLandedPrimary(args: {
  libraryRoot: string;
  files: ImportFileEntry[];
  primaryIndex: number;
  sidecarIndexes: number[];
  record: RecordFile;
  landedDest: string;
  interrupted: boolean;
  seams: ResumeSeams;
}): Promise<void> {
  const { libraryRoot, files, primaryIndex, sidecarIndexes, record, landedDest, seams } = args;
  const { interrupted } = args;
  const primary = files[primaryIndex];
  // A primary that was not recorded as copied is being published afresh, and
  // a fresh copy takes the sidecars an earlier run skipped with it as well.
  const outstanding = (state: ImportFileEntry['state']): boolean =>
    state === 'pending' || (primary.state !== 'copied' && state === 'skipped_duplicate');
  const toPlace = sidecarIndexes.filter((index) => outstanding(files[index].state));
  const followers = sidecarDestsBeside(
    files,
    primaryIndex,
    sidecarIndexes.filter((index) => files[index].state !== 'copied'),
    landedDest,
  );
  const destOf = new Map(followers.map((sidecar) => [sidecar.index, sidecar.destRel]));
  if (!interrupted && toPlace.length > 0) await seams.markPublishing(primaryIndex, landedDest);
  await record(primaryIndex, 'copied', null, landedDest, renamedSidecars(files, followers));

  let newlyCopied = 0;
  for (const sIdx of sidecarIndexes) {
    const sidecar = files[sIdx];
    const destRel = destOf.get(sIdx) ?? sidecar.dest;
    if (!toPlace.includes(sIdx)) {
      await record(sIdx, sidecar.state, sidecar.error, destRel);
      continue;
    }
    const r = interrupted
      ? await placeInterruptedSidecar(libraryRoot, sidecar.src, destRel)
      : await publishFile(libraryRoot, sidecar.src, destRel);
    if (r.state === 'copied') newlyCopied += 1;
    await record(sIdx, r.state, r.error, r.destRel);
  }

  if (primary.kind === 'image' && (interrupted || newlyCopied > 0)) {
    await seams.handOffToIndexer(destAbsPath(libraryRoot, landedDest));
    await seams.rearmSidecarIndex(landedDest.split('/').pop() ?? landedDest);
  }
}
