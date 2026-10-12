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
 * and the config's `preview_supported: false` lets the UI skip asking.
 */

import { Elysia } from 'elysia';
import path from 'node:path';
import { ObjectId } from '../db/object-id.ts';
import { child as childLogger } from '../log.ts';
import { createJob, getJob, listJobs, requestCancel } from '../job-runner/jobs.repo.ts';
import { probePanoCliFlags } from '../pano/pano-cli-flags.ts';
import { newPreviewDir, ownedPreviewDir, PREVIEW_FILES } from '../pano/pano-previews.ts';
import {
  activePanoJob,
  NOT_PROVISIONED,
  panoJobPayload,
  panoJobRunning,
  provisionedPanoConfig,
  resolveStitchInputs,
  StitchBody,
} from './pano.ts';

const log = childLogger('pano:preview-routes');

async function supersedeActivePreviews(): Promise<number> {
  const active = await listJobs({
    kind: 'pano_preview',
    statuses: ['queued', 'running'],
    limit: 50,
  });
  await Promise.all(active.map((job) => requestCancel(job._id)));
  return active.length;
}

export const panoPreviewRoutes = new Elysia({ prefix: '/api/pano' })
  .post(
    '/preview',
    async ({ body, set }) => {
      const cfg = await provisionedPanoConfig();
      if (cfg === null) {
        set.status = 409;
        return NOT_PROVISIONED;
      }
      if (!(await probePanoCliFlags(cfg.maple_cli_path)).preview) {
        set.status = 409;
        return {
          error: 'pano_preview_unsupported',
          message: 'The configured maple-cli predates the quick panorama preview.',
        };
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
      const superseded = await supersedeActivePreviews();
      const payload = await panoJobPayload(cfg, body, inputs.uniqueIds, newPreviewDir());
      const doc = await createJob({ kind: 'pano_preview', payload });
      log.info(
        { jobId: doc._id.toHexString(), superseded, alignmentIn: payload.alignmentIn },
        'pano preview queued',
      );
      set.status = 201;
      return {
        id: doc._id.toHexString(),
        ...(inputs.indexedCount > 0 ? { indexing: inputs.indexedCount } : {}),
      };
    },
    { body: StitchBody },
  )

  .get('/jobs/:id/preview', async ({ params, set }) => {
    if (!ObjectId.isValid(params.id)) {
      set.status = 400;
      return { error: 'Invalid job id' };
    }
    const doc = await getJob(new ObjectId(params.id));
    const dir = doc?.kind === 'pano_preview' ? ownedPreviewDir(doc.payload.outputDir) : null;
    const file = dir === null ? null : Bun.file(path.join(dir, PREVIEW_FILES.image));
    if (doc?.status !== 'done' || file === null || !(await file.exists())) {
      set.status = 404;
      return { error: 'Pano preview not found' };
    }
    return new Response(file, {
      headers: { 'content-type': 'image/png', 'cache-control': 'private, no-store' },
    });
  });
