import { randomUUID } from 'node:crypto';
import { Elysia, t } from 'elysia';
import { requireAuth, requireOwner } from '../auth/middleware.ts';
import {
  loadHttpsConfig,
  saveHttpsConfig,
  publicHttpsConfig,
  validateHttpsConfig,
} from '../network/managed-https-config.ts';
import { managedHttps } from '../network/managed-https.ts';

const bodySchema = t.Object({
  enabled: t.Boolean(),
  hostname: t.String({ maxLength: 253 }),
  port: t.Number(),
  email: t.String({ maxLength: 254 }),
  zone_id: t.String({ maxLength: 32 }),
  api_token: t.Optional(t.Union([t.String({ maxLength: 512 }), t.Null()])),
  http3: t.Boolean(),
  terms_agreed: t.Boolean(),
});
export const managedHttpsRoutes = new Elysia({ prefix: '/api/network/https' })
  .use(requireAuth)
  .use(requireOwner)
  .get('/', async () => ({
    config: publicHttpsConfig(await loadHttpsConfig()),
    status: managedHttps.status(),
  }))
  .put(
    '/',
    async ({ body, set }) => {
      const previous = await loadHttpsConfig();
      const config = {
        ...body,
        hostname: body.hostname.trim().toLowerCase(),
        email: body.email.trim(),
        zone_id: body.zone_id.trim(),
        api_token: body.api_token === null ? '' : body.api_token?.trim() || previous.api_token,
        revision: randomUUID(),
      };
      const error = validateHttpsConfig(config);
      if (error) {
        set.status = 400;
        return { error };
      }
      // Unchanged saves must not reset the ACME backoff/rate-limit protection.
      const { revision: _oldRevision, ...oldConfig } = previous;
      const { revision: _newRevision, ...newConfig } = config;
      const unchanged = Object.keys(newConfig).every(
        (key) =>
          newConfig[key as keyof typeof newConfig] === oldConfig[key as keyof typeof oldConfig],
      );
      const saved = unchanged ? previous : config;
      await saveHttpsConfig(saved);
      void managedHttps.refresh();
      return { config: publicHttpsConfig(saved), status: managedHttps.status() };
    },
    { body: bodySchema },
  );
