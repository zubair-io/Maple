import { searchByIds } from '../db/repos/search.repo.ts';
import type { SearchWhere } from '../db/repos/search.repo.ts';
import type { GeneratedSearchDoc } from '../workers/generated-search/repo.ts';
import { resolveSearchWhere, toSearchQuery } from '../workers/generated-search/execute.ts';
import { loadLibraryIdToSlug, loadLibraryRoots } from '../indexer/libraries.cache.ts';
import { projectAssets, type SearchResult } from './search/project.ts';

export function canServeStoredPage(
  doc: GeneratedSearchDoc,
  offset: number,
  snapshot: string | undefined,
): doc is GeneratedSearchDoc & { first_page_ids: string[] } {
  const stored = doc.first_page_ids;
  return snapshot === '1' && offset === 0 && stored !== null && stored.length > 0;
}

export async function storedPage(
  doc: GeneratedSearchDoc & { first_page_ids: string[] },
  where: SearchWhere,
): Promise<{ snapshot: true; total: number; results: SearchResult[] }> {
  const ids = doc.first_page_ids;
  const [docs, libs, idToSlug] = await Promise.all([
    searchByIds(where, ids),
    loadLibraryRoots().catch(() => new Map<string, string>()),
    loadLibraryIdToSlug().catch(() => new Map<string, string>()),
  ]);
  return {
    snapshot: true as const,
    total: doc.result_count,
    results: await projectAssets(docs, libs, idToSlug),
  };
}

export async function liveCoverAssetId(doc: GeneratedSearchDoc): Promise<string | null> {
  if (doc.cover_asset_id === null) return null;
  const prepared = await resolveSearchWhere(toSearchQuery(doc.query, doc.library_id));
  if ('error' in prepared) return null;
  const [survivor] = await searchByIds(prepared.where, [doc.cover_asset_id]);
  return survivor === undefined ? null : doc.cover_asset_id;
}
