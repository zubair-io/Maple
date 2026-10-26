/**
 * Embed stage. Renders the production embedder template for an asset, embeds it with the bundled
 * bge-m3 — the same model the search child embeds queries with, running in that child — and
 * stores the L2-normalised vector in `asset_vectors` (#5445).
 *
 * Derived data only: vectors live in SQLite, never in an XMP sidecar.
 *
 * Re-embedding is driven two ways. Bumping `EMBEDDER_TEMPLATE_SHAPE_VERSION` raises this stage's
 * target version, which re-queues every asset. And `onProgress` sweeps once a minute for vectors
 * another model wrote (an Ollama `nomic-embed-text`, say) and re-queues those. A bge-m3 vector is
 * current whoever wrote it, so a library Ollama's bge-m3 embedded is kept as it is.
 * Stages that change template text (describe, transcribe, geocode, ...) re-arm `embed` through
 * `invalidates`.
 *
 * While the search child is not running or is still loading the model (a first boot downloads
 * ~2.2 GB), a claim is deferred rather than failed, so no asset dead-letters waiting for it.
 */

import type { ImageDoc, StageContext, StageResult } from '../run-stage.ts';
import { defineStage, runStage, type RunStageHandle } from '../run-stage.ts';
import {
  EMBEDDER_TEMPLATE_SHAPE_VERSION,
  embedderDocumentFor,
  renderEmbedderDocument,
} from '../../enrichment/embedder-document.ts';
import { upsertAssetVectorStatement } from '../../db/repos/asset-vectors.repo.ts';
import { SEARCH_EMBEDDING_MODEL } from '../../db/repos/asset-vectors.search.ts';
import { assetPrimaryFileInfo } from '../../indexer/images.repo.ts';
import type { AssetFaceDoc, Place, TranscriptDoc } from '../../db/schema.ts';
import type { EmbedOutcome } from '../../search/search-protocol.ts';
import { createBatcher } from '../embed/batcher.ts';
import { sweepForeignVectors } from '../embed/embedder-rearm.ts';
import { BUNDLED_ENDPOINT, embedDocuments, EMBED_BATCH } from '../embed/bundled-embedder.ts';
import { loadNamedPeople, peopleNamesForFaces } from '../../people/asset-person-names.ts';

const EMBED_STAGE_VERSION = EMBEDDER_TEMPLATE_SHAPE_VERSION;

const BATCH_LINGER_MS = 25;

/** How long a claim waits for the search engine before it is tried again. */
const ENGINE_WAIT_MS = 30_000;

interface EmbeddableImage {
  maple_id?: string;
  deleted_at?: string | null;
  description?: string | null;
  ocr_text?: string | null;
  transcript?: TranscriptDoc | null;
  place?: Place | null;
  faces?: AssetFaceDoc[] | null;
}

type EmbeddedText =
  | { ok: true; vector: Float32Array }
  | { ok: false; waiting: boolean; error: string };

function perText(outcome: EmbedOutcome, count: number): EmbeddedText[] {
  return outcome.ok
    ? outcome.vectors.map((vector) => ({ ok: true, vector }))
    : Array.from({ length: count }, () => outcome);
}

const batcher = createBatcher(
  async (texts: readonly string[]) => perText(await embedDocuments(texts), texts.length),
  { maxBatch: EMBED_BATCH, lingerMs: BATCH_LINGER_MS },
);

export async function embedHandler(image: ImageDoc, ctx: StageContext): Promise<StageResult> {
  if (ctx.lease === undefined) throw new Error('embed: the runner did not pass the claim lease');
  const embeddable = image as EmbeddableImage;
  const mapleId = embeddable.maple_id ?? '';
  if (mapleId.length === 0) return { skip: 'no-maple-id' };
  if (embeddable.deleted_at) return { skip: 'trashed' };
  const primary = assetPrimaryFileInfo(image as never);
  if (!primary) return { skip: 'no-resolvable-location' };

  const faces = embeddable.faces ?? null;
  const people = peopleNamesForFaces(faces, await loadNamedPeople([faces]));
  const text = renderEmbedderDocument(embedderDocumentFor(embeddable, primary.filename, people));
  const embedded = await batcher.submit(text);
  if (!embedded.ok && embedded.waiting) {
    return { defer: { reason: embedded.error, retryAt: new Date(Date.now() + ENGINE_WAIT_MS) } };
  }
  if (!embedded.ok) throw new Error(`embed: ${embedded.error}`);

  return {
    patch: [
      upsertAssetVectorStatement(
        {
          mapleId,
          version: EMBED_STAGE_VERSION,
          model: SEARCH_EMBEDDING_MODEL,
          endpoint: BUNDLED_ENDPOINT,
          vector: embedded.vector,
          embeddedAt: new Date(),
        },
        { assetId: image._id.toHexString(), lease: ctx.lease },
      ),
    ],
  };
}

const embedStage = defineStage({
  name: 'embed',
  targetVersion: EMBED_STAGE_VERSION,
  dependsOn: ['exif'],
  defaults: {
    concurrency: 64,
    maxAttempts: 3,
    paused: false,
    last_seen_target_version: 0,
    pausedOnFirstBoot: false,
  },
  handler: embedHandler,
  onProgress: sweepForeignVectors,
});

export default embedStage;

export async function startEmbedStage(): Promise<RunStageHandle> {
  return runStage(embedStage);
}
