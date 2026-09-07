/** Resume preserves the ledger; retry creates a fresh job containing failures only. */
import { Elysia, t } from 'elysia';
import { ObjectId } from 'mongodb';
import { getJob, resumeBatchJob } from '../job-runner/jobs.repo.ts';
import { parseExportPayload } from '../export/export-payload.ts';
import type { JobDoc } from '../db/schema.ts';
import { parseSyncPayload } from '../job-runner/handlers/batch-adjustment-sync.ts';
import { cameraBaseline } from '../job-runner/handlers/batch-white-balance.ts';
import { resolveAndAuthorizePath } from './xmp-path-auth.ts';
import { safeWriteAllowed } from '../fs/root.ts';
import { createdJobResponse, createJobResponse, createRetryFailedJob } from './jobs-create.ts';

function retrySource(previous: JobDoc) {
  if (previous.kind === 'batch_adjustment_sync')
    return { kind: previous.kind, payload: parseSyncPayload(previous.payload) };
  const raw =
    previous.kind === 'batch_jpeg_export'
      ? previous.checkpoint?.['exportPayload']
      : previous.payload;
  if (!raw || typeof raw !== 'object') throw new Error('Export has no saved snapshot to retry');
  return {
    kind: 'batch_recipe_export' as const,
    payload: parseExportPayload(raw as Record<string, unknown>),
  };
}
function retryPayload(previous: JobDoc | null) {
  if (
    !previous ||
    !['batch_adjustment_sync', 'batch_recipe_export', 'batch_jpeg_export'].includes(
      previous.kind,
    ) ||
    !['done', 'cancelled', 'failed'].includes(previous.status)
  )
    return 'Wait for the batch to stop before retrying failures';
  try {
    const source = retrySource(previous);
    const entries = previous.checkpoint?.['failed'];
    const failed = new Set(Array.isArray(entries) ? entries.map((entry) => entry.id) : []);
    const targets = source.payload.targets.filter((target) => failed.has(target.id));
    if (!targets.length) return 'This batch has no failures to retry';
    return { kind: source.kind, payload: { ...source.payload, targets } };
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

export const batchSyncJobRoutes = new Elysia()
  .get(
    '/batch-baseline',
    async ({ query, set }) => {
      const path = await resolveAndAuthorizePath(query.path);
      if (!path.ok) {
        set.status = path.status;
        return { error: path.error };
      }
      const allowed = await safeWriteAllowed(path.data);
      if (!allowed.ok) {
        set.status = 403;
        return { error: allowed.error };
      }
      try {
        return await cameraBaseline(path.data);
      } catch (error) {
        set.status = 422;
        return {
          error: error instanceof Error ? error.message : String(error),
        };
      }
    },
    { query: t.Object({ path: t.String() }) },
  )
  .post('/:id/resume', async ({ params, set }) => {
    if (!ObjectId.isValid(params.id)) {
      set.status = 400;
      return { error: 'Invalid job id' };
    }
    if (!(await resumeBatchJob(new ObjectId(params.id)))) {
      set.status = 409;
      return { error: 'Only an interrupted batch can be resumed' };
    }
    return { id: params.id };
  })
  .post(
    '/:id/retry-failed',
    async ({ params, body, set }) => {
      if (!ObjectId.isValid(params.id)) {
        set.status = 400;
        return { error: 'Invalid job id' };
      }
      const id = new ObjectId(params.id);
      const previous = await getJob(id);
      if (previous?.kind === 'batch_adjustment_sync') {
        return createdJobResponse(() => createRetryFailedJob(id, body?.requestId), set);
      }
      const retry = retryPayload(previous);
      if (typeof retry === 'string') {
        set.status = 409;
        return { error: retry };
      }
      const created = await createJobResponse({
        ...retry,
        requestId: body?.requestId,
      });
      set.status = created.status;
      return created.body;
    },
    {
      body: t.Optional(
        t.Object({
          requestId: t.Optional(t.String({ pattern: '^[a-f0-9]{24}$' })),
        }),
      ),
    },
  );
