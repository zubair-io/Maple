/**
 * The in-process branch of `GET /api/search` (#4463), taken when Settings → AI selects the
 * in-process engine.
 *
 * The child answers the free text with its fused top {@link IN_PROCESS_CANDIDATES}. Every other
 * filter of the request — library, people, hidden, dates, vision fields, screenshot, and the ones
 * Meilisearch cannot express — is then the translated `where`, evaluated in SQL against those ids,
 * so the total and every page come from one filtered, ranked list. The Meilisearch branch has to
 * decline a filter it cannot push down because it only ever sees one page; this branch holds the
 * whole candidate list, so it never needs to.
 *
 * `null` means the engine is not selected or could not answer, and the caller takes today's path.
 * No diversity reorder here: that is a workaround for Meilisearch's single-word ranking.
 */

import { mapleIdsMatching, searchByMapleIds } from '../../db/repos/search.repo.ts';
import { inProcessRanking } from '../../search/search-engine-selection.ts';
import { libraryMaps } from './libraries.ts';
import { usesPlaceText, type MeiliPage, type MeiliPageInput } from './list-meili.ts';
import { projectAssets } from './project.ts';

export async function inProcessPage(
  input: Omit<MeiliPageInput, 'libraryId'>,
): Promise<MeiliPage | null> {
  const { where, resolved, skip, limit } = input;
  if (!usesPlaceText(resolved)) return null;
  const hits = await inProcessRanking(resolved.placeQuery!.trim());
  if (!hits) return null;
  const ranked = await mapleIdsMatching(
    where,
    hits.map((hit) => hit.id),
  );
  const page = ranked.slice(skip, skip + limit);
  const semantic = new Set(hits.filter((hit) => hit.vectorRank !== null).map((hit) => hit.id));
  const docs = await searchByMapleIds(where, page);
  const { libs, idToSlug } = await libraryMaps();
  return {
    total: ranked.length,
    results: await projectAssets(docs, libs, idToSlug),
    rankedBy: { engine: 'in-process', semanticHits: page.filter((id) => semantic.has(id)).length },
  };
}
