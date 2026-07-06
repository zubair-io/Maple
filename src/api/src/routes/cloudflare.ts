/**
 * /api/cloudflare/* — operator-facing routes for the Cloudflare R2
 * thumbnail-mirror (see #1757). Every route is owner-gated: R2 credentials
 * and the enable toggle are consequential settings, not something a
 * `member`-role account should read or change.
 *
 *   GET  /api/cloudflare/config — current effective config (secret redacted)
 *   PUT  /api/cloudflare/config — save new config; validates credentials
 *                                 before persisting when enabling
 *   POST /api/cloudflare/test   — round-trip a probe object through R2
 *                                 without saving (UI "Test" button)
 *
 * There is deliberately no backfill/sync trigger here — mirroring existing
 * thumbnails to R2 is the `cf-thumb-sync` pipeline stage
 * (`workers/stages/cf-thumb-sync.ts`), controlled from Settings → Workers
 * like every other stage (pause/resume, concurrency, progress), not a
 * one-off job behind a button on this page. See CLAUDE.md's worker-design
 * convention.
 */

import { Elysia, t } from 'elysia';
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

const log = childLogger('cloudflare:routes');

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
      // uploads that only surface later in the cf-thumb-sync stage's
      // dead-letter list.
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
  );
