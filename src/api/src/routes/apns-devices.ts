/**
 * /api/apns/devices — device-token registration for the File Provider APNs
 * push-to-signal channel (#1025).
 *
 *   POST   /api/apns/devices — register (upsert) this device's push token.
 *   DELETE /api/apns/devices — unregister this device's push token.
 *   GET    /api/apns/devices — the caller's own registered devices.
 *
 * Registration is per (user, device), NOT per library — a File Provider
 * domain covers a whole connected server, with every library on it
 * surfacing as a sub-tree inside that one domain, so there is no
 * per-library push channel on the Apple side to scope to. See
 * `apns/apns-devices.repo.ts`'s file header for the full reasoning.
 *
 * Self-gates with `.use(requireAuth)` plus the same `requireFileAccess`
 * check every other file-access-gated route module runs — registering a
 * device is effectively subscribing to server-wide change activity over
 * push, the same filesystem-adjacent trust tier as the SSE/poll
 * change-feed routes (`changes.ts`), so a member without file access must
 * not be able to do it either. Composed as `requireAuth` +
 * `requireFileAccessBeforeHandle` at THIS module's own top level rather
 * than `.use(requireFileAccess)` (which wraps both inside one more level
 * of nesting): every other `.use(requireFileAccess)` call site is mounted
 * inside `authedApi`, which supplies its own outer `.use(requireAuth)` —
 * this route module is the first to self-gate stand-alone, and the extra
 * nesting level left `requireAuth`'s missing-bearer throw not propagating
 * far enough for `app.handle()` to see it, so an unauthenticated request
 * fell through to `requireFileAccessBeforeHandle`'s `!auth` branch and
 * answered 403 instead of 401 (caught by `tests/auth/routes-inventory.test.ts`).
 * `requireFileAccessBeforeHandle` is exported from `auth/middleware.ts`
 * for exactly this "attach without the wrapper" shape. Mounted OUTSIDE the
 * shared `authedApi` sub-app in `src/index.ts` (same pattern as
 * `auth-device-sessions.ts`) because every handler here scopes to
 * `auth.user.sub` — `authedApi`'s other routes are deliberately
 * library-wide with no per-user scoping (see `routes/presets.ts`).
 */

import { Elysia, t } from 'elysia';
import { ObjectId } from 'mongodb';
import { requireAuth, requireFileAccessBeforeHandle } from '../auth/middleware.ts';
import {
  listDeviceTokensForUser,
  normalizeDeviceToken,
  registerDeviceToken,
  unregisterDeviceToken,
} from '../apns/apns-devices.repo.ts';
import type { ApnsDeviceTokenWithId } from '../db/schema.ts';

function toResponse(d: ApnsDeviceTokenWithId) {
  return {
    device_token: d.device_token,
    platform: d.platform,
    environment: d.environment,
    updated_at: d.updated_at.toISOString(),
  };
}

const RegisterBody = t.Object({
  device_token: t.String({ minLength: 1, maxLength: 512 }),
  platform: t.Union([t.Literal('ios'), t.Literal('macos')]),
  environment: t.Union([t.Literal('sandbox'), t.Literal('production')]),
});

const UnregisterBody = t.Object({
  device_token: t.String({ minLength: 1, maxLength: 512 }),
});

export const apnsDeviceRoutes = new Elysia({ prefix: '/api/apns/devices' })
  .use(requireAuth)
  .onBeforeHandle({ as: 'scoped' }, requireFileAccessBeforeHandle)
  .get('/', async ({ auth }) => ({
    devices: (await listDeviceTokensForUser(new ObjectId(auth.user.sub))).map(toResponse),
  }))
  .post(
    '/',
    async ({ auth, body, set }) => {
      const deviceToken = normalizeDeviceToken(body.device_token);
      if (!deviceToken) {
        set.status = 400;
        return { error: 'device_token must be a hex-encoded APNs token' };
      }
      await registerDeviceToken({
        userId: new ObjectId(auth.user.sub),
        deviceToken,
        platform: body.platform,
        environment: body.environment,
      });
      return new Response(null, { status: 204 });
    },
    { body: RegisterBody },
  )
  .delete(
    '/',
    async ({ auth, body, set }) => {
      const deviceToken = normalizeDeviceToken(body.device_token);
      if (!deviceToken) {
        set.status = 400;
        return { error: 'device_token must be a hex-encoded APNs token' };
      }
      await unregisterDeviceToken({
        userId: new ObjectId(auth.user.sub),
        deviceToken,
      });
      return new Response(null, { status: 204 });
    },
    { body: UnregisterBody },
  );
