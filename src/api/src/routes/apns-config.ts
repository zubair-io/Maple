/**
 * /api/apns/config — operator-facing on/off switch for the File Provider
 * APNs push-to-signal channel (#1025).
 *
 *   GET /api/apns/config — current effective config plus whether the server
 *                           process has MAPLE_APNS_* credentials set, so the
 *                           Settings → Network page can explain why flipping
 *                           the toggle on might still do nothing.
 *   PUT /api/apns/config — save the toggle, return the re-resolved config.
 *
 * Mounted behind `requireAuth` in `routes/authed-api.ts` — same trust tier
 * as `render-config.ts` and `network.ts`'s settings routes: any signed-in
 * user can flip it, matching how the rest of the non-owner-gated settings
 * surfaces are handled (the nav itself is what's owner-gated).
 */

import { Elysia, t } from 'elysia';
import {
  hasApnsCredentials,
  loadApnsSettingsConfig,
  resolveApnsSettingsConfig,
  saveApnsSettingsConfig,
} from '../apns/apns-config.repo.ts';

// Not exported: nothing outside this file constructs the response shape
// (the web client hand-types its own DTO from the wire JSON, same as every
// other settings route here — see `network.ts`'s equivalent).
interface ApnsConfigResponse {
  enabled: boolean;
  /** Whether MAPLE_APNS_KEY_ID / MAPLE_APNS_TEAM_ID / MAPLE_APNS_PRIVATE_KEY
   * are all set on this server process. `enabled: true` with this `false`
   * means push is silently a no-op and clients stay on the SSE fallback. */
  credentials_configured: boolean;
}

function response(config: { enabled: boolean }): ApnsConfigResponse {
  return { enabled: config.enabled, credentials_configured: hasApnsCredentials() };
}

const ConfigBody = t.Object({
  enabled: t.Optional(t.Union([t.Boolean(), t.Null()])),
});

export const apnsConfigRoutes = new Elysia({ prefix: '/api/apns' })
  .get('/config', async () => response(resolveApnsSettingsConfig(await loadApnsSettingsConfig())))
  .put(
    '/config',
    async ({ body }) => {
      await saveApnsSettingsConfig({
        ...(body.enabled !== undefined ? { enabled: body.enabled } : {}),
      });
      return response(resolveApnsSettingsConfig(await loadApnsSettingsConfig()));
    },
    { body: ConfigBody },
  );
