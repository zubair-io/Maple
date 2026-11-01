/**
 * /api/pano quick-preview routes (#4580).
 *
 *   POST /api/pano/preview          — create a pano_preview job, returns { id }
 *   GET  /api/pano/jobs/:id/preview — the finished preview as a PNG
 *
 * Status and cancel go through the shared `GET`/`DELETE /api/pano/jobs/:id`.
 *
 * A new preview supersedes any queued or running one (the dialog re-previews
 * on every option change), so those are cancelled rather than refused. A
 * running full stitch still refuses with 409 `pano_job_running`: both are
 * heavy, and the JobRunner would only queue the preview behind it anyway.
 * A binary without the preview flags answers 409 `pano_preview_unsupported`,
 * and the config's `preview_supported: false` lets the UI skip asking. The
 * matcher plan (and its 409s) is the stitch route's, so a preview and the
 * stitch it leads to match with the same engine.
 */

import { Elysia } from 'elysia';
import path from 'node:path';
import { child as childLogger } from '../log.ts';
import { newPreviewDir, ownedPreviewDir, PREVIEW_FILES } from '../pano/pano-previews.ts';
import { activePanoJob, admitPanoPreview, panoJobRunning } from '../pano/pano-admission.ts';
import {
  edgesRefusal,
  findPanoJob,
  panoJobPayload,
  planStitch,
  resolveStitchInputs,
  StitchBody,
} from './pano.ts';

const log = childLogger('pano:preview-routes');

const PREVIEW_KIND: ReadonlySet<string> = new Set(['pano_preview']);

export const panoPreviewRoutes = new Elysia({ prefix: '/api/pano' })
  .post(
    '/preview',
    async ({ body, set }) => {
      const stitchPlan = await planStitch();
      if ('refusal' in stitchPlan) {
        set.status = 409;
        return stitchPlan.refusal;
      }
      if (!stitchPlan.capabilities.preview) {
        set.status = 409;
        return {
          error: 'pano_preview_unsupported',
          message: 'The configured maple-cli predates the quick panorama preview.',
        };
      }
      const unsupportedEdges = edgesRefusal(stitchPlan, body);
      if (unsupportedEdges) {
        set.status = 409;
        return unsupportedEdges;
      }
      const stitching = await activePanoJob('pano_stitch');
      if (stitching !== null) {
        set.status = 409;
        return panoJobRunning(stitching._id);
      }
      const inputs = await resolveStitchInputs(body);
      if ('rejection' in inputs) {
        set.status = inputs.status;
        return inputs.rejection;
      }
      const payload = await panoJobPayload(stitchPlan, body, inputs.uniqueIds, newPreviewDir());
      const admitted = await admitPanoPreview(payload);
      if ('running' in admitted) {
        set.status = 409;
        return panoJobRunning(admitted.running._id);
      }
      const { created, superseded } = admitted;
      log.info(
        { jobId: created._id.toHexString(), superseded, alignmentIn: payload.alignmentIn },
        'pano preview queued',
      );
      set.status = 201;
      return {
        id: created._id.toHexString(),
        ...(inputs.indexedCount > 0 ? { indexing: inputs.indexedCount } : {}),
      };
    },
    { body: StitchBody },
  )

  .get('/jobs/:id/preview', async ({ params, set }) => {
    const found = await findPanoJob(params.id, PREVIEW_KIND);
    if ('status' in found) {
      set.status = found.status;
      return { error: found.error };
    }
    const dir = ownedPreviewDir(found.doc.payload.outputDir);
    const file = dir === null ? null : Bun.file(path.join(dir, PREVIEW_FILES.image));
    if (found.doc.status !== 'done' || file === null || !(await file.exists())) {
      set.status = 404;
      return { error: 'Pano preview not found' };
    }
    return new Response(file, {
      headers: { 'content-type': 'image/png', 'cache-control': 'private, no-store' },
    });
  });
