/** Resume preserves the ledger; retry creates a fresh job containing failures only. */
import { Elysia, t } from 'elysia';
import { ObjectId } from 'mongodb';
import { createJob, getJob, resumeBatchJob } from '../job-runner/jobs.repo.ts';
import { parseSyncPayload } from '../job-runner/handlers/batch-adjustment-sync.ts';

export const batchSyncJobRoutes = new Elysia()
  .post('/:id/resume', async ({ params, set }) => {
    if (!ObjectId.isValid(params.id)) {
      set.status = 400;
      return { error: 'Invalid job id' };
    }
    if (!(await resumeBatchJob(new ObjectId(params.id)))) {
      set.status = 409;
      return { error: 'Only an interrupted batch sync can be resumed' };
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
      if (
        !previous ||
        previous.kind !== 'batch_adjustment_sync' ||
        !['done', 'cancelled', 'failed'].includes(previous.status)
      ) {
        set.status = 409;
        return { error: 'Wait for the batch to stop before retrying failures' };
      }
      const payload = parseSyncPayload(previous.payload);
      const entries = previous.checkpoint?.['failed'];
      const failed = new Set(Array.isArray(entries) ? entries.map((entry) => entry.id) : []);
      const targets = payload.targets.filter((target) => failed.has(target.id));
      if (targets.length === 0) {
        set.status = 409;
        return { error: 'This batch has no failures to retry' };
      }
      const created = await createJob({
        kind: 'batch_adjustment_sync',
        payload: { targets, patch: payload.patch },
        requestId: body?.requestId,
      });
      set.status = 201;
      return { id: created._id.toHexString() };
    },
    {
      body: t.Optional(
        t.Object({ requestId: t.Optional(t.String({ pattern: '^[a-f0-9]{24}$' })) }),
      ),
    },
  );
