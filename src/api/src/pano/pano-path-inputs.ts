/**
 * Resolving the absolute paths a stitch request names to asset ids.
 *
 * Every path is realpath-resolved and must sit under a registered library root;
 * the deepest root wins, so a library nested inside another owns its own files.
 * A path outside every root is refused with a 400 — arbitrary server paths can
 * never be indexed or stitched. A path with no live asset is indexed on demand
 * through the discover watcher's own per-file path (a skeleton row; enrichment
 * stays with the normal stages), unless the library excludes it (`.mapleignore`,
 * or a reserved tree such as `.maple/`), which is a 400 the user can act on.
 */

import fs from '../fs/mirrored.ts';
import path from 'node:path';
import { ObjectId } from '../db/object-id.ts';
import {
  findAssetLocationsByFilenames,
  type AssetLocationsRow,
} from '../db/repos/assets.by-filename.ts';
import { isUnderRoot } from '../fs/browse.ts';
import { loadLibraryRoots } from '../indexer/libraries.cache.ts';
import { child as childLogger } from '../log.ts';
import { refusesIgnoredTreeEvent } from '../workers/discover/folder-ignore.ts';
import { refusesReservedTreeEvent } from '../workers/discover/reserved-trees.ts';

const log = childLogger('pano:path-inputs');

/** Every registered library root as realpath sees it, deepest first. */
interface CanonicalRoots {
  roots: { canonRoot: string; folderId: ObjectId }[];
  /** Folder id → canonical root, for rebuilding an entry's absolute path. */
  byFolderId: Map<string, string>;
}

// A root that does not exist on disk is kept as stored — an offline volume is
// not a reason to drop a library out of the jail.
async function canonicaliseRoots(libs: ReadonlyMap<string, string>): Promise<CanonicalRoots> {
  const entries = await Promise.all(
    [...libs].map(async ([id, root]) => ({
      id,
      canonRoot: await fs.realpath(root).catch(() => root),
    })),
  );
  return {
    roots: entries
      .map(({ id, canonRoot }) => ({ canonRoot, folderId: new ObjectId(id) }))
      .sort((a, b) => b.canonRoot.length - a.canonRoot.length),
    byFolderId: new Map(entries.map(({ id, canonRoot }) => [id, canonRoot])),
  };
}

const pathError = (message: string, code: string) =>
  Object.assign(new Error(message), { status: 400, code });

interface NormalizedPath {
  absPath: string;
  owningRoot: string;
  owningFolderId: ObjectId;
  filename: string;
}

async function normalizePath(rawPath: string, canon: CanonicalRoots): Promise<NormalizedPath> {
  const absPath = await fs.realpath(rawPath).catch(() => {
    throw pathError(`Path does not exist or cannot be accessed: ${rawPath}`, 'path_not_found');
  });
  const owner = canon.roots.find(({ canonRoot }) => isUnderRoot(absPath, canonRoot));
  if (!owner) {
    throw pathError(
      `Path is outside every registered library root and cannot be stitched: ${absPath}`,
      'path_outside_library',
    );
  }
  return {
    absPath,
    owningRoot: owner.canonRoot,
    owningFolderId: owner.folderId,
    filename: path.basename(absPath),
  };
}

/** The live asset whose live location is exactly `p`, or null. */
function liveAssetAt(p: NormalizedPath, docs: readonly AssetLocationsRow[], canon: CanonicalRoots) {
  const matches = (entry: AssetLocationsRow['fileinfo'][number]) => {
    if (entry.filename !== p.filename || entry.deleted_at || entry.missing_since) return false;
    const libRoot = canon.byFolderId.get(entry.library_id.toHexString());
    const segments = entry.path === '' ? [] : entry.path.split('/');
    return libRoot !== undefined && path.join(libRoot, ...segments, entry.filename) === p.absPath;
  };
  return docs.find((doc) => doc.fileinfo.some(matches))?._id.toHexString() ?? null;
}

async function indexOnDemand(p: NormalizedPath, canon: CanonicalRoots): Promise<string> {
  const event = { kind: 'created' as const, absPath: p.absPath };
  const excluded =
    refusesReservedTreeEvent(event, p.owningRoot) ||
    (await refusesIgnoredTreeEvent(event, p.owningRoot));
  if (excluded) {
    throw pathError(
      `The library excludes this file (.mapleignore or a reserved folder), so it cannot be stitched: ${p.absPath}`,
      'path_excluded',
    );
  }
  log.info({ absPath: p.absPath }, 'pano/stitch: indexing file on-demand');
  const { handleEvent } = await import('../workers/discover/index.ts');
  await handleEvent(event, p.owningFolderId, p.owningRoot);
  const id = liveAssetAt(p, await findAssetLocationsByFilenames([p.filename]), canon);
  if (id === null) {
    throw Object.assign(new Error(`Failed to index file on-demand: ${p.absPath}`), {
      status: 500,
      code: 'index_on_demand_failed',
    });
  }
  return id;
}

/** Asset ids for `paths`, in order, and how many had to be indexed first. */
export async function resolveAssetPaths(
  paths: string[],
): Promise<{ resolvedIds: string[]; indexedCount: number }> {
  const canon = await canonicaliseRoots(await loadLibraryRoots());
  const normalized = await Promise.all(paths.map((raw) => normalizePath(raw, canon)));
  const candidates = await findAssetLocationsByFilenames([
    ...new Set(normalized.map((p) => p.filename)),
  ]);
  const resolvedIds: string[] = [];
  let indexedCount = 0;
  for (const p of normalized) {
    const found = liveAssetAt(p, candidates, canon);
    if (found === null) indexedCount++;
    resolvedIds.push(found ?? (await indexOnDemand(p, canon)));
  }
  return { resolvedIds, indexedCount };
}
