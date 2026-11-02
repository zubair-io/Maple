/**
 * Import steps that act on a primary whose fate is already known: the duplicate
 * probe that decides whether an image is skipped, and the resume of an image a
 * previous run already landed (a retry, or a reclaimed run).
 */

import type { ImportFileEntry } from '../db/schema.ts';
import { destAbsPath } from './copy.ts';

export type RecordFile = (
  index: number,
  state: ImportFileEntry['state'],
  error: string | null,
  destRel: string,
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
  copyOne: (
    libraryRoot: string,
    src: string,
    destRel: string,
  ) => Promise<{ state: ImportFileEntry['state']; error: string | null; destRel: string }>;
  handOffToIndexer: (absPath: string) => Promise<void>;
  rearmSidecarIndex: (imageFilename: string) => Promise<void>;
}

/**
 * Copies the still-pending sidecars of an already-landed primary and re-records
 * everything else unchanged. When a sidecar newly lands next to an image the
 * library already indexed, the image is handed to the indexer again and its
 * sidecar-metadata index is re-armed, because that stage may already have
 * settled on "no sidecar" for it.
 */
export async function resumeLandedPrimary(args: {
  libraryRoot: string;
  files: ImportFileEntry[];
  primaryIndex: number;
  sidecarIndexes: number[];
  record: RecordFile;
  seams: ResumeSeams;
}): Promise<void> {
  const { libraryRoot, files, primaryIndex, sidecarIndexes, record, seams } = args;
  const primary = files[primaryIndex];
  await record(primaryIndex, 'copied', null, primary.dest);

  let newlyCopied = 0;
  for (const sIdx of sidecarIndexes) {
    const sidecar = files[sIdx];
    if (sidecar.state !== 'pending') {
      await record(sIdx, sidecar.state, sidecar.error, sidecar.dest);
      continue;
    }
    const r = await seams.copyOne(libraryRoot, sidecar.src, sidecar.dest);
    if (r.state === 'copied') newlyCopied += 1;
    await record(sIdx, r.state, r.error, r.destRel);
  }

  if (primary.kind === 'image' && newlyCopied > 0) {
    await seams.handOffToIndexer(destAbsPath(libraryRoot, primary.dest));
    await seams.rearmSidecarIndex(primary.dest.split('/').pop() ?? primary.dest);
  }
}
