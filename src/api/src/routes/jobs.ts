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

import { Elysia, t } from 'elysia';
import { ObjectId } from 'mongodb';
import type { JobKind, JobStatus, JobWithId } from '../db/schema.ts';
import { getJob, listJobs, requestCancel } from '../job-runner/jobs.repo.ts';

import { parseExportPayload } from '../export/export-payload.ts';
import { parseSyncPayload } from '../job-runner/handlers/batch-adjustment-sync.ts';
import { batchSyncJobRoutes } from './jobs-batch-sync.ts';
import { createJobResponse } from './jobs-create.ts';

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
    ...(doc.checkpoint
      ? {
          checkpoint: {
            applied: doc.checkpoint['applied'],
            failed: doc.checkpoint['failed'],
            remaining: doc.checkpoint['remaining'],
            skipped: doc.checkpoint['skipped'],
            outputs: doc.checkpoint['outputs'],
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
    ['kind', KNOWN_KINDS],
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

export const jobsRoutes = new Elysia({ prefix: '/api/jobs' })
  .post(
    '/',
    async ({ body, set }) => {
      if (!KNOWN_KINDS.has(body.kind as JobKind)) {
        set.status = 400;
        return { error: `Unknown job kind: ${body.kind}` };
      }
      if (body.kind === 'batch_adjustment_sync' || body.kind === 'batch_recipe_export') {
        try {
          if (body.kind === 'batch_recipe_export') parseExportPayload(body.payload);
          else parseSyncPayload(body.payload);
        } catch (error) {
          set.status = 400;
          return {
            error: error instanceof Error ? error.message : String(error),
          };
        }
      }
      const created = await createJobResponse({
        kind: body.kind as JobKind,
        payload: body.payload as Record<string, unknown>,
        requestId: body.requestId,
      });
      set.status = created.status;
      return created.body;
    },
    { body: CreateBody },
  )

  .get(
    '/',
    async ({ query, set }) => {
      // Existing import/job route validation is parallel, but the DTOs and repositories differ.
      // fallow-ignore-next-line code-duplication
      const filter = parseListFilter(query);
      if (typeof filter === 'string') {
        set.status = 400;
        return { error: filter };
      }
      const docs = await listJobs(filter);
      return { jobs: docs.map((doc) => projectJob(doc)) };
    },
    { query: ListQuery },
  )

  .get('/:id', async ({ params, query, set }) => {
    if (!ObjectId.isValid(params.id)) {
      set.status = 400;
      return { error: 'Invalid job id' };
    }
    const doc = await getJob(new ObjectId(params.id));
    if (!doc) {
      set.status = 404;
      return { error: 'Job not found' };
    }
    return projectJob(doc, query.summary === '1');
  })

  .post('/:id/cancel', async ({ params, set }) => {
    if (!ObjectId.isValid(params.id)) {
      set.status = 400;
      return { error: 'Invalid job id' };
    }
    const ok = await requestCancel(new ObjectId(params.id));
    if (!ok) {
      set.status = 404;
      return { error: 'Job not found' };
    }
    return { ok: true };
  })
  .use(batchSyncJobRoutes);
