import { Elysia, t } from 'elysia';
import { loadDisplayConfig, saveDisplayConfig } from '../display/display-config.repo.ts';

export const displayRoutes = new Elysia()
  .get('/api/display/config', async () => {
    return await loadDisplayConfig();
  })
  .put(
    '/api/display/config',
    async ({ body }) => {
      await saveDisplayConfig(body);
      return { ok: true };
    },
    {
      body: t.Object({
        show_hidden_images: t.Optional(t.Boolean()),
        stack_raw_jpeg: t.Optional(t.Boolean()),
      }),
    },
  );
