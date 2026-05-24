/**
 * POST /api/admin/re-embed-faces — operator-triggered face re-embedding.
 *
 * Re-runs the recognizer (ArcFace R100 trained on Glint360K) against every
 * face document whose `embedding_version` is missing or doesn't match the
 * current pipeline tag. Use after upgrading the face pipeline (e.g.
 * buffalo_s -> antelopev2, or any future model swap) to bring legacy
 * embeddings into the new space.
 *
 * Idempotent: calling twice on a fully-migrated DB returns zero work.
 *
 * Operator workflow after a pipeline upgrade:
 *
 *   1. Deploy the new API binary (this code).
 *   2. POST /api/admin/re-embed-faces — wait for it to finish. The
 *      response is a JSON summary of counts; the request streams nothing
 *      so very large libraries will hold the HTTP connection open for
 *      minutes. Background workers continue normally.
 *   3. Once re-embedding is done, the operator separately re-runs
 *      clustering (POST /api/people/recluster or equivalent) so the
 *      `PersonDoc.centroid` values get rebuilt in the new embedding
 *      space. The two operations are intentionally decoupled — re-embed
 *      preserves existing person assignments; re-cluster does not.
 *
 * Mounted behind `requireAuth` (alongside `meilisearchBackfillRoutes`)
 * so only an authenticated operator can kick it off. Returns 503 if
 * the face models haven't been loaded yet (worker disabled, or models
 * missing on disk) — there's no point starting work the recognizer
 * can't complete.
 *
 * Cancellation: AbortSignal wired from the route's `request.signal`. If
 * the client disconnects mid-run, the loop exits cleanly between assets
 * and the response is never read — but the migration's partial work is
 * persisted, so the next POST picks up where it left off.
 */

import { Elysia } from 'elysia';
import { reEmbedFaces } from '../workers/jobs/re-embed-faces.ts';
import { getFaceModelsStatus } from '../enrichment/face-models.ts';
import { child as childLogger } from '../log.ts';

const log = childLogger('admin:re-embed-faces');

export const reEmbedFacesRoutes = new Elysia({
  prefix: '/api/admin',
}).post('/re-embed-faces', async ({ set, request }) => {
  // Gate on model status: if the face worker has never been enabled in
  // this process, the recognizer ONNX session isn't live and the
  // migration would fail on the first face. We surface a clean 503
  // rather than burning through assets and dead-lettering each one.
  const status = getFaceModelsStatus();
  if (status.kind !== 'loaded') {
    set.status = 503;
    return {
      error:
        'Face models are not loaded. Enable the face worker via /settings/enrichment first so the recognizer ONNX session boots, then retry the migration.',
      face_models_status: status.kind,
      face_models_error: status.errorDetail,
    };
  }

  log.info('re-embed-faces migration starting');
  try {
    const result = await reEmbedFaces({ signal: request.signal });
    log.info(result, 're-embed-faces migration complete');
    return result;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error({ err: msg }, 're-embed-faces migration failed');
    set.status = 500;
    return { error: msg };
  }
});
