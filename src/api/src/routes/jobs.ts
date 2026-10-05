/**
 * /api/jobs — JobRunner HTTP surface.
 *
 *   POST /api/jobs                  — create a queued job, returns `{ id }`
 *   GET  /api/jobs/:id              — full job document with progress
 *   POST /api/jobs/:id/cancel       — set `cancel_requested: true`
 *   GET  /api/jobs?status=&kind=&limit=  — list jobs (newest first)
 *
 * The route lives behind `requireAuth`, so it is registered inside the
 * auth-gated sub-app in `src/index.ts`. See `docs/workers-architecture.md`
 * §9, §11 for the design context.
 */

import { Elysia, status, t } from 'elysia';
import { requireOwnerBeforeHandle } from '../auth/middleware.ts';
import type { SqliteDb } from '../db/repos/db-handle.ts';
import { ObjectId } from '../db/object-id.ts';
import type { JobKind, JobStatus, JobWithId } from '../db/schema.ts';
import { createJob, getJob, listJobs, requestCancel } from '../job-runner/jobs.repo.ts';

import { initialExportPayload } from '../export/export-initial-payload.ts';
import { parseSyncPayload } from '../job-runner/handlers/batch-adjustment-sync.ts';
import { createBatchSyncJobRoutes } from './jobs-batch-sync.ts';
import { createdJobResponse } from './jobs-create.ts';

const KNOWN_KINDS: ReadonlySet<JobKind> = new Set([
  'batch_jpeg_export',
  'batch_adjustment_sync',
  'batch_recipe_export',
]);
const KNOWN_STATUSES: ReadonlySet<JobStatus> = new Set([
  'queued',
  'running',
  'done',
  'failed',
  'cancelled',
]);

interface JobView {
  id: string;
  kind: JobKind;
  status: JobStatus;
  payload?: Record<string, unknown>;
  checkpoint?: Record<string, unknown>;
  progress: { current: number; total: number };
  result: Record<string, unknown> | null;
  error: string | null;
  cancel_requested: boolean;
  created_at: string;
  updated_at: string;
}

function projectJob(doc: JobWithId, compact = false): JobView {
  return {
    id: doc._id.toHexString(),
    kind: doc.kind,
    status: doc.status,
    ...(compact ? {} : { payload: doc.payload }),
    ...(Array.isArray(doc.checkpoint?.['applied'])
      ? {
          checkpoint: {
            applied: doc.checkpoint!['applied'],
            failed: doc.checkpoint!['failed'],
            remaining: doc.checkpoint!['remaining'],
            skipped: doc.checkpoint!['skipped'],
            outputs: doc.checkpoint!['outputs'],
          },
        }
      : {}),
    progress: doc.progress,
    result: doc.result,
    error: doc.error,
    cancel_requested: doc.cancel_requested,
    created_at: doc.created_at,
    updated_at: doc.updated_at,
  };
}

const CreateBody = t.Object({
  kind: t.String(),
  payload: t.Record(t.String(), t.Unknown()),
  requestId: t.Optional(t.String({ pattern: '^[a-f0-9]{24}$' })),
});

const ListQuery = t.Object({
  status: t.Optional(t.String()),
  kind: t.Optional(t.String()),
  limit: t.Optional(t.String()),
});

function parseListFilter(query: { status?: string; kind?: string; limit?: string }) {
  for (const [key, allowed] of [
    ['status', KNOWN_STATUSES],
    ['kind', new Set([...KNOWN_KINDS, 'cloud_backup_restore'])],
  ] as const) {
    const value = query[key];
    if (value && !(allowed as ReadonlySet<string>).has(value)) return `Unknown ${key}: ${value}`;
  }
  const requestedLimit = query.limit ? Number(query.limit) : 50;
  if (!Number.isFinite(requestedLimit) || requestedLimit < 1)
    return `Invalid limit: ${query.limit}`;
  return {
    status: query.status as JobStatus | undefined,
    kind: query.kind as JobKind | undefined,
    limit: Math.min(200, Math.floor(requestedLimit)),
  };
}

export function createJobsRoutes(dbOverride?: SqliteDb) {
  return new Elysia({ prefix: '/api/jobs' })
    .post(
      '/',
      async ({ body, set }) => {
        if (!KNOWN_KINDS.has(body.kind as JobKind)) {
          set.status = 400;
          return { error: `Unknown job kind: ${body.kind}` };
        }
        try {
          if (body.kind === 'batch_adjustment_sync') parseSyncPayload(body.payload);
          const normalized =
            body.kind === 'batch_recipe_export'
              ? await initialExportPayload(body.payload, body.requestId, dbOverride)
              : { payload: body.payload };
          return createdJobResponse(
            () =>
              createJob(
                {
                  ...normalized,
                  kind: body.kind as JobKind,
                  requestId: body.requestId,
                },
                undefined,
                dbOverride,
              ),
            set,
          );
        } catch (error) {
          set.status = 400;
          return {
            error: error instanceof Error ? error.message : String(error),
          };
        }
      },
      { body: CreateBody },
    )

    .get(
      '/',
      async (context) => {
        const { query } = context;
        const filter = parseListFilter(query);
        if (typeof filter === 'string') return status(400, { error: filter });
        const owner = Reflect.get(context, 'auth')?.user?.role === 'owner';
        const docs = await listJobs(
          { ...filter, ...(owner ? {} : { excludeKind: 'cloud_backup_restore' as const }) },
          dbOverride,
        );
        return {
          jobs: docs.map((doc) => projectJob(doc)),
        };
      },
      { query: ListQuery },
    )

    .get('/:id', async (context) => {
      const { params, query } = context;
      if (!ObjectId.isValid(params.id)) return status(400, { error: 'Invalid job id' });
      const doc = await getJob(new ObjectId(params.id), dbOverride);
      if (!doc) return status(404, { error: 'Job not found' });
      if (doc.kind === 'cloud_backup_restore') {
        const denial = requireOwnerBeforeHandle({
          auth: Reflect.get(context, 'auth'),
          set: context.set,
        });
        if (denial) return denial;
      }
      return projectJob(doc, query.summary === '1');
    })

    .post('/:id/cancel', async (context) => {
      const { params, set } = context;
      if (!ObjectId.isValid(params.id)) {
        set.status = 400;
        return { error: 'Invalid job id' };
      }
      const doc = await getJob(new ObjectId(params.id), dbOverride);
      if (doc?.kind === 'cloud_backup_restore') {
        const denial = requireOwnerBeforeHandle({ auth: Reflect.get(context, 'auth'), set });
        if (denial) return denial;
      }
      const ok = await requestCancel(new ObjectId(params.id), undefined, dbOverride);
      if (!ok) {
        set.status = 404;
        return { error: 'Job not found' };
      }
      return { ok: true };
    })
    .use(createBatchSyncJobRoutes(dbOverride));
}

export const jobsRoutes = createJobsRoutes();
