/**
 * Single source of truth for the managed embedder's document template and
 * the fingerprint that identifies the active vector configuration.
 *
 * Why its own module: the template string was previously written twice —
 * once in `meilisearch-index-settings.ts` (what Meilisearch is told) and
 * once in `meilisearch-client.ts`'s fingerprint hash (what decides whether
 * a re-embed is needed). Editing one and not the other left every asset
 * marked as vector-covered under a template it was never embedded with.
 *
 * `ASSET_DOC_SHAPE_VERSION` is the version of the DOCUMENT we push, not of
 * the template alone. It is folded into the fingerprint so a change to the
 * set of fields the template dereferences invalidates coverage — Meilisearch
 * re-embeds from documents already in the index, so a template that reads a
 * field the indexed documents do not carry yet must NOT be treated as
 * covered. See `meilisearch-vector-coverage.ts`.
 *
 * The meili stage's `targetVersion` is bound to this constant: a document
 * shape change is exactly the condition under which every asset must be
 * re-upserted.
 */

import { createHash } from 'node:crypto';

/** Bump whenever the fields written into `MeilisearchAssetDoc` change. */
export const ASSET_DOC_SHAPE_VERSION = 8;

/**
 * Rendered by Meilisearch for every document to produce the embedding input.
 *
 * Labelled, one field per line, and deliberately NOT including `searchBlob`.
 * The previous template (`{{ doc.searchBlob }} {{ doc.description }}
 * {{ doc.people }}`) had two defects: it embedded description twice, and its
 * largest segment was `searchBlob` — a lowercased, deduped, ALPHABETICALLY
 * SORTED token bag. A sentence embedder reads word order and repetition; the
 * blob has neither, so a real video transcript reached the embedder as
 * scrambled tokens while a generic photo caption reached it as fluent prose.
 * That asymmetry is why transcript-rich videos under-ranked (#2384).
 *
 * `transcript` is last: it is by far the longest field, so if Ollama's
 * context window is reached the truncation lands in the transcript tail
 * rather than dropping the shorter, denser fields entirely.
 * `asset-doc-fields.ts` also caps it explicitly.
 *
 * Every `{{ doc.x }}` here MUST have a matching key in
 * `TEMPLATE_FIELD_DEFAULTS` below — see the note there.
 */
export const EMBEDDER_DOCUMENT_TEMPLATE = [
  'Filename: {{ doc.filename }}',
  'Media type: {{ doc.mediaType }}',
  // People sits high for the same reason it sits second in
  // `searchableAttributes`: a name query wants photos OF that person. The
  // field is short, so its position costs nothing downstream.
  'People: {{ doc.people }}',
  'Visual description: {{ doc.description }}',
  'Place: {{ doc.placeText }}',
  'OCR: {{ doc.ocrText }}',
  'Video transcript: {{ doc.transcript }}',
].join('\n');

/**
 * Every key the template above dereferences, with the value a document gets
 * when it does not supply one.
 *
 * This lives beside the template because it is the template's own invariant:
 * once an embedder is configured, Meilisearch renders the template for EVERY
 * incoming document with strict liquid lookups, and a document MISSING any
 * referenced key rejects its WHOLE BATCH (`invalid_document_fields` — #2369,
 * hit live by tombstone docs during the semantic backfill). Adding a
 * `{{ doc.x }}` to the template without adding `x` here is that bug.
 *
 * Null-VALUED keys render fine (`composeDocument` has always sent
 * `description: null` / `people: null`), so the defaults mirror that shape.
 * `POST /documents` is a full replace, so defaulting a key can never clobber
 * live state.
 */
export const TEMPLATE_FIELD_DEFAULTS = {
  searchBlob: '',
  filename: '',
  mediaType: null,
  description: null,
  transcript: null,
  ocrText: null,
  people: null,
  placeText: null,
};

/** Fill in any template-referenced key the caller omitted. */
export function withTemplateFields<T extends { id: string }>(doc: T): T {
  return { ...TEMPLATE_FIELD_DEFAULTS, ...doc };
}

export interface VectorFingerprintInput {
  /** The Meili embedder name we register (`caption`). */
  embedderName: string;
  /** Fully-joined Ollama embed endpoint. */
  embedUrl: string;
  /** Ollama embedding model id. */
  model: string;
}

/**
 * Stable, non-secret identity of the active vector configuration, prefixed
 * with the document-shape version so callers can compare shapes without
 * re-deriving the hash.
 */
export function vectorFingerprint(input: VectorFingerprintInput): string {
  const digest = createHash('sha256')
    .update(
      JSON.stringify({
        version: 1,
        embedder: input.embedderName,
        url: input.embedUrl,
        model: input.model,
        documentTemplate: EMBEDDER_DOCUMENT_TEMPLATE,
      }),
    )
    .digest('hex');
  return `v${ASSET_DOC_SHAPE_VERSION}:${digest}`;
}
