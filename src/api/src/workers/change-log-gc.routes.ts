// change-log-gc.routes.ts — HTTP API routes for change log retention & GC (#3741).
import { Elysia, t } from 'elysia';
import {
  loadChangeLogRetentionDays,
  saveChangeLogRetentionDays,
  loadChangeLogGcConfig,
  saveChangeLogGcConfig,
  type ChangeLogGcConfig,
} from './change-log-gc-config.repo.ts';
import { runChangeLogGcOnce } from './change-log-gc.ts';

export function changeLogGcRoutes() {
  return new Elysia({ prefix: '/change-log-gc' })
    .get('/retention-window', async () => {
      return { days: await loadChangeLogRetentionDays() };
    })
    .patch(
      '/retention-window',
      async ({ body, set }) => {
        try {
          const days = await saveChangeLogRetentionDays((body as { days: number }).days);
          return { ok: true, days };
        } catch (err) {
          set.status = 500;
          return { error: err instanceof Error ? err.message : String(err) };
        }
      },
      { body: t.Object({ days: t.Number({ minimum: 1, maximum: 3650 }) }) },
    )
    .get('/config', async () => {
      return await loadChangeLogGcConfig();
    })
    .patch(
      '/config',
      async ({ body, set }) => {
        try {
          const config = await saveChangeLogGcConfig(body as Partial<ChangeLogGcConfig>);
          return { ok: true, config };
        } catch (err) {
          set.status = 500;
          return { error: err instanceof Error ? err.message : String(err) };
        }
      },
      {
        body: t.Object({
          retention_days: t.Optional(t.Number({ minimum: 1, maximum: 3650 })),
        }),
      },
    )
    .post('/run', async ({ set }) => {
      try {
        const summary = await runChangeLogGcOnce();
        return { ok: true, ...summary };
      } catch (err) {
        set.status = 500;
        return { error: err instanceof Error ? err.message : String(err) };
      }
    });
}
