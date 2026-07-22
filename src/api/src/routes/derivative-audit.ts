/**
 * /api/derivative-audit — operator surface for the derivative-audit worker.
 *
 *   GET  /api/derivative-audit/status — current config + last-pass progress
 *   PUT  /api/derivative-audit/config — patch the DB-backed config
 *   POST /api/derivative-audit/run    — kick a pass now (returns immediately)
 *
 * Mounted behind `requireAuth` in `src/index.ts`, beside `mirrorRoutes`.
 */
import { Elysia, t } from 'elysia';
import {
  loadDerivativeAuditConfig,
  saveDerivativeAuditConfig,
} from '../workers/derivative-audit/config.repo.ts';
import { runDerivativeAuditOnce } from '../workers/derivative-audit/scan.ts';
import { getDerivativeAuditProgress } from '../workers/derivative-audit/progress.ts';

// Guards the operator "Run now" action against overlapping manual kicks (the
// interval loop has its own in-flight guard).
let runInFlight = false;

export const derivativeAuditRoutes = new Elysia()
  .get('/api/derivative-audit/status', async () => ({
    config: await loadDerivativeAuditConfig(),
    progress: getDerivativeAuditProgress(),
  }))
  .put(
    '/api/derivative-audit/config',
    async ({ body }) => {
      await saveDerivativeAuditConfig(body);
      return { ok: true, config: await loadDerivativeAuditConfig() };
    },
    {
      body: t.Object({
        enabled: t.Optional(t.Boolean()),
        interval_ms: t.Optional(t.Integer({ minimum: 60_000 })),
        max_resets_per_pass: t.Optional(t.Integer({ minimum: 1, maximum: 1_000_000 })),
        concurrency: t.Optional(t.Integer({ minimum: 1, maximum: 64 })),
        deep_r2_enabled: t.Optional(t.Boolean()),
      }),
    },
  )
  .post('/api/derivative-audit/run', () => {
    if (runInFlight) return { started: false, reason: 'already-running' };
    runInFlight = true;
    void runDerivativeAuditOnce().finally(() => {
      runInFlight = false;
    });
    return { started: true };
  });
