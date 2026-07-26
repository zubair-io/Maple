/**
 * /api/render/* — operator-facing routes for the render runtime config
 * (#1062). Today that is exactly one knob: the web GPU live-render ramp/kill
 * switch.
 *
 *   GET /api/render/config — current effective config + source (db / default).
 *   PUT /api/render/config — save, return the re-resolved config.
 *
 * Both routes are mounted behind `requireAuth` — see `src/index.ts`. The GET is
 * read by every signed-in web client at startup and on a periodic refresh; the
 * PUT is the Settings → Workers toggle. There is deliberately no separate
 * owner-only guard on the write: the settings surface is owner-gated in the
 * nav, matching how the observability, network and display config routes are
 * handled.
 */

import { Elysia, t } from 'elysia';
import {
  loadRenderConfig,
  resolveRenderConfig,
  saveRenderConfig,
} from '../render/render-config.repo.ts';

const ConfigBody = t.Object({
  /** Web GPU live-render ramp/kill. `null` clears back to the built-in
   * default (on); omitted leaves the saved value alone. */
  gpu_live_render_enabled: t.Optional(t.Union([t.Boolean(), t.Null()])),
});

export const renderConfigRoutes = new Elysia({ prefix: '/api/render' })
  .get('/config', async () => {
    return resolveRenderConfig(await loadRenderConfig());
  })

  .put(
    '/config',
    async ({ body }) => {
      await saveRenderConfig({
        ...(body.gpu_live_render_enabled !== undefined
          ? { gpu_live_render_enabled: body.gpu_live_render_enabled }
          : {}),
      });
      return resolveRenderConfig(await loadRenderConfig());
    },
    { body: ConfigBody },
  );
