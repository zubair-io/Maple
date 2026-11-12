/**
 * /api/derivative-audit — operator surface for the derivative-audit worker.
 *
 *   GET  /api/derivative-audit/status — current config + the latest pass's progress
 *   PUT  /api/derivative-audit/config — patch the DB-backed config
 *   POST /api/derivative-audit/run    — ask the worker tier for a pass now (returns immediately)
 *
 * Passes run in the worker tier, scheduled or requested; their progress is
 * persisted (`progress.ts`), so the status shows either kind.
 *
 * Mounted behind `requireAuth` in `src/index.ts`, beside `mirrorRoutes`.
 */
import { Elysia, t } from 'elysia';
import { requireOwnerBeforeHandle } from '../auth/middleware.ts';
import {
  loadDerivativeAuditConfig,
  saveDerivativeAuditConfig,
} from '../workers/derivative-audit/config.repo.ts';
import {
  loadDerivativeAuditProgress,
  passInProgress,
} from '../workers/derivative-audit/progress.ts';
import {
  maintenanceRunRequested,
  requestMaintenanceRun,
} from '../workers/maintenance/run-now.repo.ts';

const DERIVATIVE_AUDIT_TASK = 'derivative-audit';

/**
 * The latest pass, reported as running from the moment one is asked for, so a
 * client polling after Run now sees it before the worker tier picks it up. A
 * pass that stopped saving long ago died with its process and is not running.
 */
async function currentProgress() {
  const saved = await loadDerivativeAuditProgress();
  const running = passInProgress(saved) || (await maintenanceRunRequested(DERIVATIVE_AUDIT_TASK));
  return { ...saved.summary, running };
}

export const derivativeAuditRoutes = new Elysia()
  .get('/api/derivative-audit/status', async () => ({
    config: await loadDerivativeAuditConfig(),
    progress: await currentProgress(),
  }))
  .put(
    '/api/derivative-audit/config',
    async ({ body }) => {
      await saveDerivativeAuditConfig(body);
      return { ok: true, config: await loadDerivativeAuditConfig() };
    },
    {
      beforeHandle: requireOwnerBeforeHandle,
      body: t.Object({
        enabled: t.Optional(t.Boolean()),
        interval_ms: t.Optional(t.Integer({ minimum: 60_000 })),
        max_resets_per_pass: t.Optional(t.Integer({ minimum: 1, maximum: 1_000_000 })),
        concurrency: t.Optional(t.Integer({ minimum: 1, maximum: 64 })),
        deep_r2_enabled: t.Optional(t.Boolean()),
      }),
    },
  )
  // Ask for a pass now, whether or not the audit is enabled. Refused while a
  // pass is requested or in progress, scheduled or not.
  .post(
    '/api/derivative-audit/run',
    async () => {
      if ((await currentProgress()).running) return { started: false, reason: 'already-running' };
      await requestMaintenanceRun(DERIVATIVE_AUDIT_TASK, { force: true });
      return { started: true };
    },
    { beforeHandle: requireOwnerBeforeHandle },
  );
