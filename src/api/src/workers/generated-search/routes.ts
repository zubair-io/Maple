/**
 * `/api/workers/generated-search/config` — the daily run's operator knobs.
 *
 * A standalone plugin mounted alongside `workerRoutes()` rather than inlined
 * into `routes-main.ts`: that file is already at 567 lines against a 600-line
 * hard ceiling, and these endpoints would have taken it past. Keeping them
 * next to the worker they configure is also the more cohesive home.
 *
 * DB-backed config, not env vars, per the CLAUDE.md settings rule — the
 * worker re-reads on its next pass, so a change takes effect with no restart
 * and no shell access on the server. The worker starts PAUSED (it needs
 * Ollama configured), so `paused: false` here is what actually turns the
 * feature on.
 */

import { Elysia, t } from 'elysia';
import {
  loadGeneratedSearchConfig,
  saveGeneratedSearchConfig,
  type GeneratedSearchConfig,
} from './config.repo.ts';

export const generatedSearchConfigRoutes = new Elysia({ prefix: '/api/workers' })
  .get('/generated-search/config', async () => {
    return await loadGeneratedSearchConfig();
  })

  .patch(
    '/generated-search/config',
    async ({ body, set }) => {
      try {
        const config = await saveGeneratedSearchConfig(body as Partial<GeneratedSearchConfig>);
        return { ok: true, config };
      } catch (err) {
        set.status = 500;
        return { error: err instanceof Error ? err.message : String(err) };
      }
    },
    {
      // Bounds mirror `config.repo.ts`'s clamps so an out-of-range value is
      // rejected at the edge rather than silently squashed.
      body: t.Object({
        collections_per_day: t.Optional(t.Number({ minimum: 1, maximum: 12 })),
        min_results: t.Optional(t.Number({ minimum: 1, maximum: 1000 })),
        max_rounds: t.Optional(t.Number({ minimum: 1, maximum: 10 })),
        retention_days: t.Optional(t.Number({ minimum: 1, maximum: 365 })),
        model: t.Optional(t.String()),
        paused: t.Optional(t.Boolean()),
        dry_run: t.Optional(t.Boolean()),
      }),
    },
  );
