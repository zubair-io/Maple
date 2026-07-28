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
export const ASSET_DOC_SHAPE_VERSION = 7;

/** Rendered by Meilisearch for every document to produce the embedding input. */
export const EMBEDDER_DOCUMENT_TEMPLATE =
  '{{ doc.searchBlob }} {{ doc.description }} {{ doc.people }}';

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
