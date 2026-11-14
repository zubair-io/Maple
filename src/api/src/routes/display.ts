import { Elysia, t } from 'elysia';
import { loadDisplayConfig, saveDisplayConfig } from '../display/display-config.repo.ts';

export const displayRoutes = new Elysia()
  // A client checks this before naming a stack's JPEG: an older server ignores
  // the unknown fields and would move or trash the RAW alone (#5929, #5930).
  .get('/api/display/config', async () => ({
    ...(await loadDisplayConfig()),
    stack_pair_ops_supported: true,
  }))
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
