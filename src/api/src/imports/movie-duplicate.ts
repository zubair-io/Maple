/**
 * The duplicate verdict for a movie (#5635). The catalog only nominates
 * candidates by `sha1_head`; a movie is a duplicate only when a candidate file
 * on disk, really inside the library, has the source's byte size and its
 * whole-file content hash. `hashFileForId` streams the whole file (SHA-1 over
 * every byte) and folds the size into `maple_id`, so equal `maple_id` and size
 * mean identical content, unlike `sha1_head`.
 *
 * Reading cost: a movie nothing in the catalog resembles costs one 64 KB read
 * and a query; whole files are read only once a same-size candidate exists.
 * A candidate that cannot be confirmed for any reason is simply not a match.
 */

import path from 'node:path';
import type { CandidateLocation } from '../db/repos/imports.duplicate.ts';
import type { ObjectId } from '../db/object-id.ts';
import { isWithinRoot, resolveRealPath } from '../fs/root.ts';
import type { hashFileForId, hashFileHead } from '../indexer/id.ts';
// Mirror-aware drop-in; only ever stats here.
import fs from '../fs/mirrored.ts';
import { destAbsPath } from './copy.ts';

/** Same-head clips fold into one catalog row, so nominations can be many; only whole-file reads are capped. */
const MAX_CANDIDATE_ROWS = 100;
const MAX_FULL_HASHES = 3;

export interface MovieDuplicateDeps {
  hashFileForId: typeof hashFileForId;
  hashFileHead: typeof hashFileHead;
  candidateLocationsForHead: (
    sha1Head: string,
    libraryId: ObjectId,
    limit: number,
  ) => Promise<CandidateLocation[]>;
}

function candidateAbsPath(libraryRoot: string, location: CandidateLocation): string | null {
  const segments = [...(location.path === '' ? [] : location.path.split('/')), location.filename];
  if (segments.some((s) => s === '' || s === '.' || s === '..' || s.includes('\0'))) return null;
  return destAbsPath(libraryRoot, segments.join('/'));
}

async function sizeIfFile(abs: string): Promise<number | null> {
  try {
    const stat = await fs.stat(abs);
    return stat.isFile() ? stat.size : null;
  } catch {
    return null;
  }
}

async function liesInsideLibrary(realRoot: string, abs: string): Promise<boolean> {
  try {
    return isWithinRoot(realRoot, await resolveRealPath(abs));
  } catch {
    return false;
  }
}

async function hashesLike(
  deps: MovieDuplicateDeps,
  abs: string,
  wanted: { maple_id: string; size: number },
): Promise<boolean> {
  try {
    const hashed = await deps.hashFileForId(abs);
    return hashed.size === wanted.size && hashed.maple_id === wanted.maple_id;
  } catch {
    return false;
  }
}

/** The absolute path of the library file holding the source's content, or null. */
export async function libraryFileHoldingMovie(
  deps: MovieDuplicateDeps,
  src: string,
  library: { id: ObjectId; root: string },
): Promise<string | null> {
  const head = await deps.hashFileHead(src);
  const candidates = await deps.candidateLocationsForHead(
    head.sha1_head,
    library.id,
    MAX_CANDIDATE_ROWS,
  );
  const realRoot = await resolveRealPath(library.root).catch(() => path.resolve(library.root));
  let source: { maple_id: string; size: number } | null = null;
  let fullHashes = 0;
  for (const location of candidates) {
    const abs = candidateAbsPath(library.root, location);
    if (abs === null || (await sizeIfFile(abs)) !== head.size) continue;
    if (!(await liesInsideLibrary(realRoot, abs))) continue;
    if (fullHashes === MAX_FULL_HASHES) return null;
    source ??= await deps.hashFileForId(src);
    fullHashes += 1;
    if (await hashesLike(deps, abs, source)) return abs;
  }
  return null;
}
