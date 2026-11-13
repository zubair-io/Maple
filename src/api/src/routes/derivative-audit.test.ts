import { describe, expect, it } from 'bun:test';
import { Elysia } from 'elysia';
import { addLibrary, createLiveTestDatabase } from '../workers/derivative-audit/test-support.ts';
import { derivativeAuditRoutes } from './derivative-audit.ts';
import { fakeAuth } from '../../tests/helpers/test-auth.ts';
import { patchAppSettings } from '../db/repos/app-settings.repo.ts';
import { emptySummary, saveDerivativeAuditProgress } from '../workers/derivative-audit/progress.ts';
import { pendingMaintenanceRuns } from '../workers/maintenance/run-now.repo.ts';
import { runDerivativeAuditPass } from '../workers/derivative-audit/scan.ts';
import { insertAsset, insertLocation } from '../db/sqlite/test-sqlite.test-helpers.ts';

const app = new Elysia().use(fakeAuth()).use(derivativeAuditRoutes);

describe('derivative-audit routes', () => {
  it('GET /status returns config + progress', async () => {
    using _live = await createLiveTestDatabase();
    const res = await app.handle(new Request('http://localhost/api/derivative-audit/status'));
    const body = (await res.json()) as {
      config: { enabled: boolean };
      progress: { scanned: number };
    };
    expect(body.config.enabled).toBe(true);
    expect(body.progress).toHaveProperty('scanned');
  });

  it('PUT /config persists a partial patch', async () => {
    using _live = await createLiveTestDatabase();
    const res = await app.handle(
      new Request('http://localhost/api/derivative-audit/config', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ enabled: false, deep_r2_enabled: false }),
      }),
    );
    const body = (await res.json()) as { ok: boolean; config: { enabled: boolean } };
    expect(body.config.enabled).toBe(false);

    const check = await app.handle(new Request('http://localhost/api/derivative-audit/status'));
    const checkBody = (await check.json()) as { config: { enabled: boolean } };
    expect(checkBody.config.enabled).toBe(false);
  });

  const status = async () =>
    (await (await app.handle(new Request('http://localhost/api/derivative-audit/status'))).json())
      .progress as Record<string, unknown>;

  const run = async () =>
    (
      await app.handle(new Request('http://localhost/api/derivative-audit/run', { method: 'POST' }))
    ).json();

  it('GET /status reports a pass the worker process saved', async () => {
    using _live = await createLiveTestDatabase();
    await saveDerivativeAuditProgress({
      ...emptySummary(),
      scanned: 120,
      reArmed: 3,
      byStage: { thumb: 3 },
      startedAt: '2026-11-01T00:00:00.000Z',
      running: true,
    });

    expect(await status()).toMatchObject({ scanned: 120, reArmed: 3, running: true });
  });

  it('GET /status does not report a pass whose process died mid-pass as running', async () => {
    using _live = await createLiveTestDatabase();
    await patchAppSettings('derivative_audit_progress', {
      summary: { ...emptySummary(), scanned: 5, running: true },
      saved_at: '2026-01-01T00:00:00.000Z',
    });

    expect(await status()).toMatchObject({ scanned: 5, running: false });
  });

  it('POST /run asks the worker tier for a forced pass, shown as running until it starts', async () => {
    using _live = await createLiveTestDatabase();

    expect(await run()).toEqual({ started: true });
    expect(await pendingMaintenanceRuns()).toMatchObject([
      { taskId: 'derivative-audit', options: { force: true } },
    ]);
    expect(await status()).toMatchObject({ running: true });
    expect(await run()).toEqual({ started: false, reason: 'already-running' });
  });

  it('a pass that throws is finished, with its error, and Run now starts another', async () => {
    using live = await createLiveTestDatabase();
    insertLocation(live.db, {
      assetId: insertAsset(live.db),
      libraryId: addLibrary(live.db, '/srv/library'),
      path: '',
      filename: 'a.dng',
    });
    live.db.exec('ALTER TABLE stage_state RENAME TO stage_state_unreadable');

    const thrown = await runDerivativeAuditPass(undefined, { force: true }).then(
      () => null,
      (error: unknown) => error,
    );

    expect(thrown).toBeInstanceOf(Error);
    expect(await status()).toMatchObject({
      running: false,
      finishedAt: expect.any(String),
      failure: expect.stringContaining('stage_state'),
    });
    expect(await run()).toEqual({ started: true });
  });

  it('POST /run refuses while a scheduled pass is in progress', async () => {
    using _live = await createLiveTestDatabase();
    await saveDerivativeAuditProgress({ ...emptySummary(), running: true });

    expect(await run()).toEqual({ started: false, reason: 'already-running' });
    expect(await pendingMaintenanceRuns()).toEqual([]);
  });
});
