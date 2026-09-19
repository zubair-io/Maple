/**
 * /api/change-log-gc — operator surface for the change-log-gc maintenance job
 * (#3741), surfaced in the Maintenance group on the Workers settings page.
 *
 *   GET /api/change-log-gc/status — config, last-pass summary, current row count
 *   PUT /api/change-log-gc/config — patch the DB-backed config
 *
 * The job re-reads its config from `app_settings` on every pass, so a PUT
 * takes effect on the next sweep with no restart. Mounted behind `requireAuth`
 * beside `derivativeAuditRoutes`, whose shape this mirrors.
 *
 * There is deliberately no "run now": the sweep belongs on the worker tier's
 * event loop, not on the one serving HTTP requests.
 */

import { Elysia, t } from 'elysia';
import {
  loadChangeLogGcConfig,
  saveChangeLogGcConfig,
  type ChangeLogGcConfig,
} from '../workers/change-log-gc-config.repo.ts';
import { countChanges } from '../db/repos/changes.retention.ts';

/** How many rows the journal holds — the same count the sweep itself reports,
 * so the panel's "rows" and its last pass's "remaining" cannot disagree. Soft-
 * failed to 0, because a status panel should not 500 over a number that is
 * only informational. */
async function estimatedRows(): Promise<number> {
  try {
    return await countChanges();
  } catch {
    return 0;
  }
}

export const changeLogGcRoutes = new Elysia()
  .get('/api/change-log-gc/status', async () => {
    const config = await loadChangeLogGcConfig();
    return {
      config,
      rows: await estimatedRows(),
      pruned_through: config.last_run?.pruned_through ?? 0,
    };
  })
  .put(
    '/api/change-log-gc/config',
    async ({ body }) => ({
      ok: true,
      config: await saveChangeLogGcConfig(body as Partial<ChangeLogGcConfig>),
    }),
    {
      body: t.Object({
        enabled: t.Optional(t.Boolean()),
        retention_days: t.Optional(t.Integer({ minimum: 1, maximum: 3650 })),
      }),
    },
  );
