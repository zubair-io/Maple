/**
 * /api/cloudflare/* — operator-facing routes for the Cloudflare R2
 * thumbnail-mirror (see #1757). Every route is owner-gated: R2
 * credentials, the enable toggle, and the backfill trigger are
 * consequential settings/actions, not something a `member`-role account
 * should read or invoke.
 *
 *   GET    /api/cloudflare/config        — current effective config (secret redacted)
 *   PUT    /api/cloudflare/config        — save new config; validates credentials
 *                                          before persisting when enabling
 *   POST   /api/cloudflare/test          — round-trip a probe object through R2
 *                                          without saving (UI "Test" button)
 *   POST   /api/cloudflare/backfill      — queue a `cf_thumb_backfill` job
 *   GET    /api/cloudflare/backfill/:id  — poll that job's status/progress
 *   DELETE /api/cloudflare/backfill/:id  — cancel an in-flight backfill job
 *
 * The backfill routes mirror `/api/pano/jobs/:id`'s shape (a thin,
 * kind-scoped view over the generic JobRunner) rather than exposing the
 * generic `/api/jobs/:id` here — kind-scoping means a stray id for some
 * other job kind 404s instead of leaking cross-feature job state to this
 * owner-gated surface.
 */

import { Elysia, t } from 'elysia';
import { ObjectId } from 'mongodb';
import { child as childLogger } from '../log.ts';
import { requireAuth, requireOwner } from '../auth/middleware.ts';
import {
  loadCloudflareConfig,
  resolveCloudflareConfig,
  saveCloudflareConfig,
  toPublicCloudflareConfig,
  isCloudflareConfigComplete,
  type CloudflareConfig,
} from '../cloudflare/cloudflare-config.repo.ts';
import { testR2Credentials } from '../cloudflare/r2-client.ts';
import { createJob, getJob, listJobs, requestCancel } from '../job-runner/jobs.repo.ts';
import type { JobWithId } from '../db/schema.ts';

const log = childLogger('cloudflare:routes');

function projectBackfillJob(doc: JobWithId) {
  return {
    id: doc._id.toHexString(),
    status: doc.status,
    progress: doc.progress,
    result: doc.result,
    error: doc.error,
    cancel_requested: doc.cancel_requested,
    created_at: doc.created_at,
    updated_at: doc.updated_at,
  };
}

const ConfigBody = t.Object({
  enabled: t.Boolean(),
  account_id: t.Optional(t.Union([t.String(), t.Null()])),
  bucket: t.Optional(t.Union([t.String(), t.Null()])),
  access_key_id: t.Optional(t.Union([t.String(), t.Null()])),
  /** Secret. Write-only — `undefined`/empty leaves the saved key unchanged
   * so a blank field in the UI never wipes a key the operator can't see;
   * `null` clears it. */
  secret_access_key: t.Optional(t.Union([t.String(), t.Null()])),
});

const TestBody = t.Object({
  account_id: t.String({ minLength: 1 }),
  bucket: t.String({ minLength: 1 }),
  access_key_id: t.String({ minLength: 1 }),
  secret_access_key: t.String({ minLength: 1 }),
});

export const cloudflareRoutes = new Elysia({ prefix: '/api/cloudflare' })
  .use(requireAuth)
  .use(requireOwner)
  .get('/config', async () => {
    const resolved = resolveCloudflareConfig(await loadCloudflareConfig());
    return toPublicCloudflareConfig(resolved);
  })
  .put(
    '/config',
    async ({ body, set }) => {
      let secretAccessKey: string | null | undefined;
      if (body.secret_access_key === null) {
        secretAccessKey = null;
      } else if (typeof body.secret_access_key === 'string') {
        const trimmed = body.secret_access_key.trim();
        if (trimmed.length > 0) secretAccessKey = trimmed;
      }

      const patch: Partial<CloudflareConfig> = {
        enabled: body.enabled,
        ...(body.account_id !== undefined ? { account_id: body.account_id } : {}),
        ...(body.bucket !== undefined ? { bucket: body.bucket } : {}),
        ...(body.access_key_id !== undefined ? { access_key_id: body.access_key_id } : {}),
        ...(secretAccessKey !== undefined ? { secret_access_key: secretAccessKey } : {}),
      };

      // If the operator is turning uploads on, validate credentials BEFORE
      // persisting — a typo shouldn't silently start a stream of failed
      // uploads that only surface later in the thumb-stage warning logs.
      const existing = resolveCloudflareConfig(await loadCloudflareConfig());
      const candidate = { ...existing, ...patch };
      if (candidate.enabled) {
        if (!isCloudflareConfigComplete(candidate)) {
          set.status = 400;
          return {
            error:
              'enabled requires account_id, bucket, access_key_id, and secret_access_key to all be set',
          };
        }
        try {
          await testR2Credentials(candidate);
        } catch (err) {
          set.status = 502;
          const msg = err instanceof Error ? err.message : String(err);
          log.warn({ err: msg }, 'PUT /config R2 credential check failed');
          return { error: `R2 credential check failed: ${msg}` };
        }
      }

      await saveCloudflareConfig(patch);
      const resolved = resolveCloudflareConfig(await loadCloudflareConfig());
      return toPublicCloudflareConfig(resolved);
    },
    { body: ConfigBody },
  )
  .post(
    '/test',
    async ({ body, set }) => {
      try {
        await testR2Credentials(body);
        return { ok: true };
      } catch (err) {
        set.status = 502;
        return { ok: false, error: err instanceof Error ? err.message : String(err) };
      }
    },
    { body: TestBody },
  )

  // POST /api/cloudflare/backfill — queue a cf_thumb_backfill job. Refuses
  // when config isn't complete/enabled so the operator gets an immediate
  // 409 instead of a job that fails on its first batch. Also refuses a
  // second concurrent backfill (409 with the existing job's id) — the
  // handler's single-cursor pass already covers everything pending, so a
  // duplicate run only doubles R2 traffic and DB scans for no benefit,
  // mirroring the pano_stitch single-concurrent-job guard.
  .post('/backfill', async ({ set }) => {
    const config = resolveCloudflareConfig(await loadCloudflareConfig());
    if (!isCloudflareConfigComplete(config)) {
      set.status = 409;
      return { error: 'Cloudflare upload must be enabled with valid credentials to backfill' };
    }
    const existing = await listJobs({
      kind: 'cf_thumb_backfill',
      statuses: ['queued', 'running'],
      limit: 1,
    });
    if (existing.length > 0) {
      set.status = 409;
      return {
        error: 'A backfill job is already in progress',
        jobId: existing[0]._id.toHexString(),
      };
    }
    const doc = await createJob({ kind: 'cf_thumb_backfill', payload: {} });
    set.status = 201;
    return { id: doc._id.toHexString() };
  })

  // GET /api/cloudflare/backfill/:id — job status.
  .get('/backfill/:id', async ({ params, set }) => {
    if (!ObjectId.isValid(params.id)) {
      set.status = 400;
      return { error: 'Invalid job id' };
    }
    const doc = await getJob(new ObjectId(params.id));
    if (!doc || doc.kind !== 'cf_thumb_backfill') {
      set.status = 404;
      return { error: 'Backfill job not found' };
    }
    return projectBackfillJob(doc);
  })

  // DELETE /api/cloudflare/backfill/:id — cancel.
  .delete('/backfill/:id', async ({ params, set }) => {
    if (!ObjectId.isValid(params.id)) {
      set.status = 400;
      return { error: 'Invalid job id' };
    }
    const doc = await getJob(new ObjectId(params.id));
    if (!doc || doc.kind !== 'cf_thumb_backfill') {
      set.status = 404;
      return { error: 'Backfill job not found' };
    }
    const ok = await requestCancel(new ObjectId(params.id));
    return { ok };
  });
