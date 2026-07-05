/**
 * /api/network/* — LAN address discovery for self-hosted Maple.
 *
 *   GET /api/network/local-address — PUBLIC (no bearer). Apple + web clients
 *                                     call this on load to learn the
 *                                     server's LAN address + port, so they
 *                                     can prefer it over the public URL when
 *                                     they're actually on the same network.
 *                                     Same trust tier as `/api/health` — no
 *                                     user data, just this server's own
 *                                     network location.
 *   GET  /api/network/config — current effective config + sources.
 *   PUT  /api/network/config — validate + save the operator override.
 *
 * The config CRUD routes are mounted behind `requireAuth` (see
 * `src/index.ts`); the report route is mounted outside it.
 */

import { Elysia, t } from 'elysia';
import {
  loadNetworkConfig,
  resolveNetworkConfig,
  saveNetworkConfig,
  validateLocalAddress,
} from '../network/network-config.repo.ts';

export const networkPublicRoutes = new Elysia().get('/api/network/local-address', async () => {
  const resolved = resolveNetworkConfig(await loadNetworkConfig());
  if (!resolved.enabled || resolved.local_ip === null) {
    return { available: false as const };
  }
  return {
    available: true as const,
    ip: resolved.local_ip,
    port: resolved.local_port,
    // The Bun process itself only ever serves plain HTTP — TLS termination
    // for the public URL (if any) happens at a reverse proxy/tunnel in
    // front of it, which has no bearing on the LAN path.
    scheme: 'http' as const,
  };
});

const NetworkConfigBody = t.Object({
  enabled: t.Optional(t.Union([t.Boolean(), t.Null()])),
  local_ip_override: t.Optional(t.Union([t.String(), t.Null()])),
  local_port_override: t.Optional(t.Union([t.Number(), t.Null()])),
});

export const networkSettingsRoutes = new Elysia({ prefix: '/api/network' })
  .get('/config', async () => resolveNetworkConfig(await loadNetworkConfig()))

  .put(
    '/config',
    async ({ body, set }) => {
      let ipOverride: string | null | undefined;
      if (body.local_ip_override !== undefined) {
        const validated = validateLocalAddress(body.local_ip_override);
        if (validated && typeof validated === 'object' && 'error' in validated) {
          set.status = 400;
          return { error: `Invalid local_ip_override: ${validated.error}` };
        }
        ipOverride = validated as string | null;
      }

      if (
        body.local_port_override !== undefined &&
        body.local_port_override !== null &&
        (!Number.isInteger(body.local_port_override) ||
          body.local_port_override < 1 ||
          body.local_port_override > 65535)
      ) {
        set.status = 400;
        return { error: 'Invalid local_port_override: must be an integer between 1 and 65535' };
      }

      await saveNetworkConfig({
        ...(body.enabled !== undefined ? { enabled: body.enabled } : {}),
        ...(ipOverride !== undefined ? { local_ip_override: ipOverride } : {}),
        ...(body.local_port_override !== undefined
          ? { local_port_override: body.local_port_override }
          : {}),
      });

      return resolveNetworkConfig(await loadNetworkConfig());
    },
    { body: NetworkConfigBody },
  );
