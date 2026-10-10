/**
 * Embed stage. Renders the production embedder template for an asset, embeds it on the
 * configured Ollama host in batches, and stores the L2-normalised vector in `asset_vectors`.
 *
 * Derived data only: vectors live in SQLite, never in an XMP sidecar.
 *
 * `ai_model` on this stage's worker_config row records the endpoint and model the stage last ran
 * with, so a change also revives rows that dead-lettered under the previous one.
 *
 * Re-embedding is driven two ways. Bumping `EMBEDDER_TEMPLATE_SHAPE_VERSION` raises this stage's
 * target version, which re-queues every asset. Changing the embedding model leaves versions
 * alone, so `onProgress` sweeps for vectors written by another model or endpoint once a minute,
 * busy or idle (and the AI settings save runs the same check).
 * Stages that change template text (describe, transcribe, geocode, ...) re-arm `embed` through
 * `invalidates`.
 *
 * `pausedOnFirstBoot: true` — a full library is tens of minutes of GPU time on the operator's
 * Ollama host, so the operator confirms the endpoint and model on Settings → AI, then resumes.
 */

import type { ImageDoc, StageContext, StageResult } from '../run-stage.ts';
import { defineStage, runStage, type RunStageHandle } from '../run-stage.ts';
import { embedderDocumentFor, renderEmbedderDocument } from '../../enrichment/embedder-document.ts';
import { EMBEDDER_TEMPLATE_SHAPE_VERSION } from '../../enrichment/meilisearch-embedder-template.ts';
import {
  EMBED_BATCH_SIZE,
  embedTexts,
  type OllamaEmbedTarget,
} from '../../enrichment/ollama-embed-client.ts';
import { upsertAssetVectorStatement } from '../../db/repos/asset-vectors.repo.ts';
import { assetPrimaryFileInfo } from '../../indexer/images.repo.ts';
import type { AssetFaceDoc, Place, TranscriptDoc } from '../../db/schema.ts';
import { createBatcher } from '../embed/batcher.ts';
import { currentEmbedderTarget, freshEmbedderTarget } from '../embed/embedder-target.ts';
import { sweepEmbedderChange } from '../embed/embedder-rearm.ts';
import { loadNamedPeople, peopleNamesForFaces } from './meili.ts';

const EMBED_STAGE_VERSION = EMBEDDER_TEMPLATE_SHAPE_VERSION;

const BATCH_LINGER_MS = 25;

interface EmbeddableImage {
  maple_id?: string;
  deleted_at?: string | null;
  description?: string | null;
  ocr_text?: string | null;
  transcript?: TranscriptDoc | null;
  place?: Place | null;
  faces?: AssetFaceDoc[] | null;
}

interface EmbeddedText {
  vector: Float32Array;
  model: string;
  endpoint: string;
}

type EmbedBatchFn = (
  target: OllamaEmbedTarget,
  inputs: readonly string[],
) => Promise<Float32Array[]>;

let embedBatchImpl: EmbedBatchFn = (target, inputs) => embedTexts(target, inputs);

async function embedBatch(texts: readonly string[]): Promise<readonly EmbeddedText[]> {
  const target = await currentEmbedderTarget();
  const vectors = await embedBatchImpl(target, texts);
  const latest = await freshEmbedderTarget();
  if (latest.model !== target.model || latest.url !== target.url) {
    throw new Error('embed: the embedder changed while a batch was in flight; retrying');
  }
  return vectors.map((vector) => ({ vector, model: target.model, endpoint: target.url }));
}

const batcher = createBatcher(embedBatch, {
  maxBatch: EMBED_BATCH_SIZE,
  lingerMs: BATCH_LINGER_MS,
});

/** Test-only seam for the Ollama call. Call with `null` to restore the real client. */
export function setEmbedBatchForTests(impl: EmbedBatchFn | null): void {
  embedBatchImpl = impl ?? ((target, inputs) => embedTexts(target, inputs));
}

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
  const { vector, model, endpoint } = await batcher.submit(text);

  return {
    patch: [
      upsertAssetVectorStatement(
        {
          mapleId,
          version: EMBED_STAGE_VERSION,
          model,
          endpoint,
          vector,
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
    concurrency: 1024,
    maxAttempts: 3,
    paused: false,
    last_seen_target_version: 0,
    pausedOnFirstBoot: true,
  },
  handler: embedHandler,
  onProgress: sweepEmbedderChange,
});

export default embedStage;

export async function startEmbedStage(): Promise<RunStageHandle> {
  return runStage(embedStage);
}
