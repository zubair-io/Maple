/** Resume preserves the ledger; retry creates a fresh job containing failures only. */
import { Elysia, t } from 'elysia';
import { createJobResponse } from './jobs-create.ts';
import { ObjectId } from 'mongodb';
import { getJob, resumeBatchJob } from '../job-runner/jobs.repo.ts';
import { parseExportPayload } from '../export/export-payload.ts';
import type { JobDoc } from '../db/schema.ts';
import { parseSyncPayload } from '../job-runner/handlers/batch-adjustment-sync.ts';

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
      const previous = await getJob(new ObjectId(params.id));
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
