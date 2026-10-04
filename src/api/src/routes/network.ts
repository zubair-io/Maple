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
  isValidPort,
  loadNetworkConfig,
  resolveNetworkConfig,
  saveNetworkConfig,
  validateLocalAddress,
  type ResolvedNetworkConfig,
} from '../network/network-config.repo.ts';
import { managedHttps, type HttpsEndpoint } from '../network/managed-https.ts';
import { TLS_ENABLED } from '../runtime/tls-config.ts';
import { validatePublicOrigin } from '../network/public-origin.ts';
import { requireAuth, requireOwner } from '../auth/middleware.ts';

export interface LocalAddressResponse {
  available: boolean;
  ip?: string;
  port?: number;
  scheme?: 'http' | 'https';
  /** Preferred managed hostname; legacy IP fields remain the fallback. */
  https?: HttpsEndpoint;
}

/**
 * Pure — exported for tests so the advertised scheme can be exercised
 * without a real TLS cert (`tlsEnabled` is injected rather than read from
 * `TLS_ENABLED` directly). The Bun process serves HTTPS exactly when
 * `MAPLE_TLS_CERT`/`MAPLE_TLS_KEY` are configured (see
 * `runtime/tls-config.ts`) — this is the single place that turns that into
 * the `scheme` clients see, so `LanSwitchService` on the web side always
 * builds a candidate origin that matches what the server actually listens
 * on.
 */
export function buildLocalAddressResponse(
  resolved: ResolvedNetworkConfig,
  tlsEnabled: boolean,
  https: HttpsEndpoint | null = null,
): LocalAddressResponse {
  if (!resolved.enabled || (resolved.local_ip === null && !https)) {
    return { available: false as const };
  }
  return {
    available: true as const,
    ...(https ? { https } : {}),
    ...(resolved.local_ip ? { ip: resolved.local_ip } : {}),
    port: resolved.local_port,
    scheme: tlsEnabled ? ('https' as const) : ('http' as const),
  };
}

export const networkPublicRoutes = new Elysia().get('/api/network/local-address', async () =>
  buildLocalAddressResponse(
    resolveNetworkConfig(await loadNetworkConfig()),
    TLS_ENABLED,
    managedHttps.endpoint(),
  ),
);

const NetworkConfigBody = t.Object({
  public_origin: t.Optional(t.Union([t.String({ maxLength: 2048 }), t.Null()])),
  enabled: t.Optional(t.Union([t.Boolean(), t.Null()])),
  local_ip_override: t.Optional(t.Union([t.String(), t.Null()])),
  local_port_override: t.Optional(t.Union([t.Number(), t.Null()])),
});

export const networkSettingsRoutes = new Elysia({ prefix: '/api/network' })
  .use(requireAuth)
  .use(requireOwner)
  .get('/config', async () => resolveNetworkConfig(await loadNetworkConfig()))

  .put(
    '/config',
    async ({ body, set }) => {
      const publicOrigin =
        body.public_origin == null
          ? body.public_origin
          : (() => {
              try {
                return validatePublicOrigin(body.public_origin);
              } catch {
                return null;
              }
            })();
      if (body.public_origin && !publicOrigin) {
        set.status = 400;
        return {
          error:
            'Invalid public_origin: use HTTPS, or HTTP loopback, without a path or credentials',
        };
      }
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
        !isValidPort(body.local_port_override)
      ) {
        set.status = 400;
        return {
          error: 'Invalid local_port_override: must be an integer between 1 and 65535',
        };
      }

      await saveNetworkConfig({
        ...(publicOrigin !== undefined ? { public_origin: publicOrigin } : {}),
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
