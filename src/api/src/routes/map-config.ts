/**
 * /api/map/config — tile-source setting for the web Map view (Map T2, #2826).
 *
 *   GET /api/map/config — effective tile URL + source ('db' | 'default').
 *   PUT /api/map/config — validate + save the operator override.
 *
 * Mounted behind `requireAuth` (see `src/index.ts`), same convention as
 * `networkSettingsRoutes` / `panoRoutes` / `observabilityRoutes`.
 *
 * This route only stores/serves a base-map tile URL. It never sees or
 * forwards asset/photo coordinates — those flow through the separate
 * `/api/map/clusters` endpoint (a different ticket), not this one.
 */

import { Elysia, t } from 'elysia';
import {
  loadMapConfig,
  resolveMapConfig,
  saveMapConfig,
  validateTileUrl,
} from '../map/map-config.repo.ts';

const MapConfigBody = t.Object({
  tile_url: t.Optional(t.Union([t.String(), t.Null()])),
});

export const mapConfigRoutes = new Elysia({ prefix: '/api/map' })
  .get('/config', async () => resolveMapConfig(await loadMapConfig()))

  .put(
    '/config',
    async ({ body, set }) => {
      if (body.tile_url !== undefined) {
        const validated = validateTileUrl(body.tile_url);
        if (validated !== null && typeof validated === 'object' && 'error' in validated) {
          set.status = 400;
          return { error: `Invalid tile_url: ${validated.error}` };
        }
        await saveMapConfig({ tile_url: validated });
      }
      const resolved = resolveMapConfig(await loadMapConfig());
      return { ok: true, ...resolved };
    },
    { body: MapConfigBody },
  );
