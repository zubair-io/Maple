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

import { Elysia, t } from "elysia";
import { ObjectId } from "mongodb";
import type {
  JobKind,
  JobStatus,
  JobWithId,
} from "../db/schema.ts";
import {
  createJob,
  getJob,
  listJobs,
  requestCancel,
} from "../job-runner/jobs.repo.ts";

const KNOWN_KINDS: ReadonlySet<JobKind> = new Set(["batch_jpeg_export"]);
const KNOWN_STATUSES: ReadonlySet<JobStatus> = new Set([
  "queued",
  "running",
  "done",
  "failed",
  "cancelled",
]);

interface JobView {
  id: string;
  kind: JobKind;
  status: JobStatus;
  payload: Record<string, unknown>;
  progress: { current: number; total: number };
  result: Record<string, unknown> | null;
  error: string | null;
  cancel_requested: boolean;
  created_at: string;
  updated_at: string;
}

function projectJob(doc: JobWithId): JobView {
  return {
    id: doc._id.toHexString(),
    kind: doc.kind,
    status: doc.status,
    payload: doc.payload,
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
});

const ListQuery = t.Object({
  status: t.Optional(t.String()),
  kind: t.Optional(t.String()),
  limit: t.Optional(t.String()),
});

export const jobsRoutes = new Elysia({ prefix: "/api/jobs" })
  .post(
    "/",
    async ({ body, set }) => {
      if (!KNOWN_KINDS.has(body.kind as JobKind)) {
        set.status = 400;
        return { error: `Unknown job kind: ${body.kind}` };
      }
      const doc = await createJob({
        kind: body.kind as JobKind,
        payload: body.payload as Record<string, unknown>,
      });
      set.status = 201;
      return { id: doc._id.toHexString() };
    },
    { body: CreateBody },
  )

  .get(
    "/",
    async ({ query, set }) => {
      const filter: { status?: JobStatus; kind?: JobKind; limit?: number } = {};
      if (query.status) {
        if (!KNOWN_STATUSES.has(query.status as JobStatus)) {
          set.status = 400;
          return { error: `Unknown status: ${query.status}` };
        }
        filter.status = query.status as JobStatus;
      }
      if (query.kind) {
        if (!KNOWN_KINDS.has(query.kind as JobKind)) {
          set.status = 400;
          return { error: `Unknown kind: ${query.kind}` };
        }
        filter.kind = query.kind as JobKind;
      }
      if (query.limit !== undefined && query.limit !== "") {
        const n = Number(query.limit);
        if (!Number.isFinite(n) || n < 1) {
          set.status = 400;
          return { error: `Invalid limit: ${query.limit}` };
        }
        filter.limit = Math.min(200, Math.floor(n));
      }
      const docs = await listJobs(filter);
      return { jobs: docs.map(projectJob) };
    },
    { query: ListQuery },
  )

  .get("/:id", async ({ params, set }) => {
    if (!ObjectId.isValid(params.id)) {
      set.status = 400;
      return { error: "Invalid job id" };
    }
    const doc = await getJob(new ObjectId(params.id));
    if (!doc) {
      set.status = 404;
      return { error: "Job not found" };
    }
    return projectJob(doc);
  })

  .post("/:id/cancel", async ({ params, set }) => {
    if (!ObjectId.isValid(params.id)) {
      set.status = 400;
      return { error: "Invalid job id" };
    }
    const ok = await requestCancel(new ObjectId(params.id));
    if (!ok) {
      set.status = 404;
      return { error: "Job not found" };
    }
    return { ok: true };
  });
