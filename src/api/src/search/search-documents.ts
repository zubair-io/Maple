/**
 * The keyword text the search child indexes for each vector: the same embedder template the
 * `embed` stage renders, so the two legs of a search describe one document.
 */

import { loadMeiliAssetsByMapleIds } from '../db/repos/assets.meilisearch.ts';
import { toBackfillRows } from '../enrichment/meilisearch-backfill-compose.ts';
import { embedderDocumentFor, renderEmbedderDocument } from '../enrichment/embedder-document.ts';
import { assetPrimaryFileInfo } from '../indexer/images.repo.ts';
import { loadNamedPeople, peopleNamesForFaces } from '../workers/stages/meili.ts';

const EMPTY_TEXT = renderEmbedderDocument(embedderDocumentFor({}, null, []));

/**
 * Rendered text per content id. An id whose asset is gone still gets the empty rendering, so the
 * text index holds exactly one document per vector and its count can be checked against them.
 */
export async function searchTextsFor(
  mapleIds: readonly string[],
): Promise<ReadonlyMap<string, string>> {
  const rows = toBackfillRows(await loadMeiliAssetsByMapleIds(mapleIds));
  const names = await loadNamedPeople(rows.map((row) => row.faces));
  const rendered = new Map(
    rows.map((row) => {
      const primary = assetPrimaryFileInfo({ fileinfo: row.fileinfo ?? [] });
      const people = peopleNamesForFaces(row.faces, names);
      const text = renderEmbedderDocument(
        embedderDocumentFor(row, primary?.filename ?? null, people),
      );
      return [row.maple_id ?? '', text] as const;
    }),
  );
  return new Map(mapleIds.map((id) => [id, rendered.get(id) ?? EMPTY_TEXT] as const));
}
