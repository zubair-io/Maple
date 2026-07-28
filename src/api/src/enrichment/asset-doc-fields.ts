/**
 * Pure derivation of the prose-valued Meilisearch document fields, shared by
 * the two writers that build `MeilisearchAssetDoc`: the per-asset meili stage
 * (`workers/stages/meili.ts`) and the bulk backfill
 * (`meilisearch-backfill-compose.ts`). A field added to one writer only is a
 * silent ranking bug for half the corpus, so both call these.
 *
 * "Prose" is the point. `search_blob` is a lowercased, deduped,
 * alphabetically-sorted token bag (see `search-blob.ts`) — fine for the Mongo
 * `$text` fallback, useless as embedder input, because word order and
 * repetition are exactly what a sentence embedder reads. These fields carry
 * the original text through to the index unmodified.
 */

/** Structural shape both writers satisfy. The meili stage models the field as
 * `{ text?: string }` and the backfill as `TranscriptDoc` (`text: string`);
 * an optional-property type accepts both. */
export interface IndexableTranscript {
  text?: string | null;
}

/** Same story for place — `Place.display_name` is `string | null`. */
export interface IndexablePlace {
  display_name?: string | null;
}

/**
 * Character ceiling for the indexed transcript.
 *
 * `bge-m3` accepts 8192 tokens (~30k characters of English). The embedder
 * template also carries description, OCR text, people, and place, so budgeting
 * ~12k characters to the transcript keeps the whole rendered document inside
 * the context window with room to spare. Beyond that Ollama truncates
 * silently, and because `transcript` is the LAST field in the template
 * (see `meilisearch-embedder-template.ts`) the truncation would eat the
 * transcript tail rather than the shorter, denser fields — but an explicit,
 * tested cap is cheaper to reason about than relying on that ordering. The
 * full transcript remains searchable lexically via `search_blob` and remains
 * intact in Mongo; only the indexed copy is bounded.
 */
export const MAX_INDEXED_TRANSCRIPT_CHARS = 12_000;

/** The asset's spoken content as prose, capped and trimmed. `null` when the
 * transcribe stage has not run or produced nothing. */
export function transcriptForIndex(
  transcript: IndexableTranscript | null | undefined,
): string | null {
  const text = transcript?.text?.trim() ?? '';
  if (text.length === 0) return null;
  if (text.length <= MAX_INDEXED_TRANSCRIPT_CHARS) return text;
  const window = text.slice(0, MAX_INDEXED_TRANSCRIPT_CHARS);
  const lastSpace = window.lastIndexOf(' ');
  return (lastSpace > 0 ? window.slice(0, lastSpace) : window).trimEnd();
}

/** The asset's location as prose. Uses `place.display_name` — NOT
 * `place.search_blob`, which is itself an alphabetised token bag built by
 * `place-parser.ts:buildSearchBlob` and carries the same
 * destroys-the-semantics problem as the asset-level blob. */
export function placeTextForIndex(place: IndexablePlace | null | undefined): string | null {
  const text = place?.display_name?.trim() ?? '';
  return text.length === 0 ? null : text;
}
