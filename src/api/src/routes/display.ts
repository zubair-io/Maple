import { Elysia, t } from 'elysia';
import { loadDisplayConfig, saveDisplayConfig } from '../display/display-config.repo.ts';

export const displayRoutes = new Elysia()
  .get('/api/display/config', async () => {
    return await loadDisplayConfig();
  })
  .put(
    '/api/display/config',
    async ({ body }) => {
      await saveDisplayConfig({
        show_hidden_images: body.show_hidden_images,
      });
      return { ok: true };
    },
    {
      body: t.Object({
        show_hidden_images: t.Boolean(),
      }),
    },
  );
