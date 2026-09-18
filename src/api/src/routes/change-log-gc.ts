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
import { assetChangesCollection } from '../db/client.ts';
import { changeLogPruneFloor } from '../db/changes.repo.ts';

/** Collection metadata, not a scan — `countDocuments` on a journal this size
 * is exactly the query the ticket exists to make unnecessary. */
async function estimatedRows(): Promise<number> {
  try {
    return await (await assetChangesCollection()).estimatedDocumentCount();
  } catch {
    return 0;
  }
}

export const changeLogGcRoutes = new Elysia()
  .get('/api/change-log-gc/status', async () => {
    // `pruned_through` is the persisted retention floor, not the last pass's
    // own figure. A quiet day that deletes nothing reports 0 for itself, and
    // reading that as the journal's watermark made the page claim nothing had
    // ever been pruned the morning after a sweep removed 175 million rows.
    const [config, rows, prunedThrough] = await Promise.all([
      loadChangeLogGcConfig(),
      estimatedRows(),
      changeLogPruneFloor(),
    ]);
    return { config, rows, pruned_through: prunedThrough };
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
