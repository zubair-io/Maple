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
 * FIELD ORDER IS LOAD-BEARING, because the rendered template is truncated to
 * `EMBEDDER_TEMPLATE_MAX_BYTES` before it is embedded. Whatever sits at the
 * end is what gets dropped on a long document, so the order runs
 * highest-value-per-byte first:
 *
 *   1-4. filename / media type / people / place — tiny, high-precision, and
 *        together only a few hundred bytes.
 *   5.   description — one or two sentences of scene prose.
 *   6.   transcript  — the point of #2384. It must NOT be last: on a
 *        transcript-rich video it is the primary evidence, and putting it
 *        after OCR would let a screenshot's chrome text crowd it out.
 *   7.   OCR — last because it is the noisiest source (UI chrome, EXIF
 *        overlays). In practice it rarely competes with the transcript:
 *        assets tend to have one or the other, not both.
 *
 * EVERY FIELD REFERENCE MUST BE `{% if %}`-GUARDED. Meilisearch re-renders
 * this template against the documents ALREADY IN ITS INDEX the moment the
 * embedder settings change — documents this deployment has not re-upserted
 * yet, which therefore lack any newly-added field. A bare
 * `{{ doc.placeText }}` against such a document fails the entire
 * `settingsUpdate` task with `invalid_document_fields`
 * (`liquid: Unknown index`), so the migration can never even start. Hit live
 * on a 333k-document index during the #2384 rollout.
 *
 * `TEMPLATE_FIELD_DEFAULTS` does NOT cover this: it back-fills keys on
 * documents we SEND, and cannot retro-fit the ones already indexed. The
 * guard is what makes a template change deployable in a single release.
 * Verified against Meilisearch 1.51 — `{% if %}` renders a missing key as
 * empty, while `{{ doc.x | default: "" }}` still fails.
 */
export const EMBEDDER_DOCUMENT_TEMPLATE = [
  '{% if doc.filename %}Filename: {{ doc.filename }}{% endif %}',
  '{% if doc.mediaType %}Media type: {{ doc.mediaType }}{% endif %}',
  // People sits high for the same reason it sits second in
  // `searchableAttributes`: a name query wants photos OF that person. The
  // field is short, so its position costs nothing downstream.
  '{% if doc.people %}People: {{ doc.people }}{% endif %}',
  '{% if doc.placeText %}Place: {{ doc.placeText }}{% endif %}',
  '{% if doc.description %}Visual description: {{ doc.description }}{% endif %}',
  '{% if doc.transcript %}Video transcript: {{ doc.transcript }}{% endif %}',
  '{% if doc.ocrText %}OCR: {{ doc.ocrText }}{% endif %}',
].join('\n');

/**
 * Byte ceiling Meilisearch applies to the RENDERED template before embedding.
 *
 * Meilisearch defaults this to **400 bytes**, and Maple never set it — so
 * every vector in a pre-#2384 index was built from roughly the first 400
 * bytes of `{{ doc.searchBlob }} …`, i.e. the first ~50 tokens of an
 * ALPHABETISED token bag. Description and people were usually truncated away
 * entirely before the embedder ever saw them. Fixing the template without
 * fixing this cap would change almost nothing.
 *
 * 5000 bytes ≈ 1200 tokens: comfortably inside bge-m3's 8192-token window,
 * enough for the short fields plus a substantial transcript excerpt, and
 * small enough that re-embedding a large library stays tractable. The
 * separate `MAX_INDEXED_TRANSCRIPT_CHARS` cap in `asset-doc-fields.ts` bounds
 * the LEXICAL copy of the transcript; this bounds the EMBEDDED copy. They are
 * different budgets for different indexes and do not need to agree.
 */
export const EMBEDDER_TEMPLATE_MAX_BYTES = 5000;

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
        // Part of the identity: changing the byte ceiling changes what text
        // is actually embedded, so it must invalidate vector coverage.
        documentTemplateMaxBytes: EMBEDDER_TEMPLATE_MAX_BYTES,
      }),
    )
    .digest('hex');
  return `v${ASSET_DOC_SHAPE_VERSION}:${digest}`;
}
