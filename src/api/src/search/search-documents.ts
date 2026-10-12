/**
 * The keyword text the search child indexes for each vector: the same embedder template the
 * `embed` stage renders, so the two legs of a search describe one document.
 */

import { loadSearchDocumentRows } from '../db/repos/assets.search-documents.ts';
import { toFileInfo } from '../db/repos/assets.rows.ts';
import type { Place, TranscriptDoc } from '../db/schema.ts';
import { embedderDocumentFor, renderEmbedderDocument } from '../enrichment/embedder-document.ts';
import { assetPrimaryFileInfo } from '../indexer/images.repo.ts';
import { loadNamedPeople, peopleNamesForFaces } from '../people/asset-person-names.ts';

const EMPTY_TEXT = renderEmbedderDocument(embedderDocumentFor({}, null, []));

function decode<T>(text: string | null): T | null {
  return text === null ? null : (JSON.parse(text) as T);
}

/**
 * Rendered text per content id. An id whose asset is gone still gets the empty rendering, so the
 * text index holds exactly one document per vector and its count can be checked against them.
 */
export async function searchTextsFor(
  mapleIds: readonly string[],
): Promise<ReadonlyMap<string, string>> {
  const batch = await loadSearchDocumentRows(mapleIds);
  const faceSets = batch.rows.map((row) => batch.faces.get(row.id) ?? []);
  const names = await loadNamedPeople(faceSets);
  const rendered = new Map(
    batch.rows.map((row, index) => {
      const fileinfo = toFileInfo(batch.locations.get(row.id) ?? []);
      const primary = assetPrimaryFileInfo({ fileinfo });
      const people = peopleNamesForFaces(faceSets[index], names);
      const text = renderEmbedderDocument(
        embedderDocumentFor(
          {
            description: row.description,
            ocr_text: row.ocr_text,
            transcript: decode<TranscriptDoc>(row.transcript),
            place: decode<Place>(row.place),
          },
          primary?.filename ?? null,
          people,
        ),
      );
      return [row.maple_id, text] as const;
    }),
  );
  return new Map(mapleIds.map((id) => [id, rendered.get(id) ?? EMPTY_TEXT] as const));
}
