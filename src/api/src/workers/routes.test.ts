/**
 * `/api/workers` end to end, against a real database.
 *
 * The one property worth restating on every test in here: nothing on this path
 * counts anything. `/status` reads the snapshot the worker persisted and the
 * `worker_config` rows, and that is all — which is why several tests below seed
 * counts that no asset in the database could justify, and then assert the route
 * reports them. A route that started deriving its own numbers would fail those,
 * which is the point (#3491).
 */

import { describe, expect, it } from 'bun:test';
import { Elysia } from 'elysia';
import { workerRoutes, sanitizeWorkerConfig } from './routes.ts';
import type { WorkerConfigDoc } from '../db/repos/worker-config.repo.ts';
import { WorkerConfigRepo } from '../db/repos/worker-config.repo.ts';
import { stageRegistry } from './registry.ts';
import { ALL_STAGE_NAMES } from './stages/manifest.ts';
import {
  readStatusCountsDemand,
  writeStatusCounts,
  writeWorkerStatus,
} from '../db/repos/worker-status.repo.ts';
import type { StageStatusSnapshot } from './registry.ts';
import {
  createLiveTestDatabase,
  insertAsset,
  insertFolder,
  insertLocation,
} from '../db/sqlite/test-sqlite.test-helpers.ts';

function snapshotOf(
  names: readonly string[],
  overrides: Partial<StageStatusSnapshot> = {},
): Record<string, StageStatusSnapshot> {
  return Object.fromEntries(
    names.map((name) => [
      name,
      {
        status: 'stopped' as const,
        inFlight: 0,
        throughput: 0,
        targetVersion: 1,
        dependsOn: [],
        lastError: null,
        ...overrides,
      },
    ]),
  );
}

/** The `/status` body, with the shape the assertions below read off it. */
interface StatusBody {
  stages: Array<{ name: string } & Record<string, unknown>>;
  damaged: number;
  newlyHiddenTotal: number;
  countsAt: number | null;
}

async function status(): Promise<StatusBody> {
  const app = new Elysia().use(workerRoutes());
  const res = await app.handle(new Request('http://localhost/api/workers/status'));
  expect(res.status).toBe(200);
  return (await res.json()) as StatusBody;
}

describe('sanitizeWorkerConfig', () => {
  it('strips removed knobs (pollIntervalMs / batchSize) from a stale config', () => {
    // A row written before #674 can still carry the removed knobs. The /status
    // route and the WS status frame must NOT leak them back out.
    const stale = {
      name: 'thumb',
      concurrency: 4,
      maxAttempts: 5,
      paused: false,
      last_seen_target_version: 2,
      pollIntervalMs: 1000,
      batchSize: 25,
    } as unknown as WorkerConfigDoc;

    const clean = sanitizeWorkerConfig(stale);

    expect(clean).toEqual({
      concurrency: 4,
      maxAttempts: 5,
      paused: false,
      last_seen_target_version: 2,
    });
    expect('pollIntervalMs' in clean).toBe(false);
    expect('batchSize' in clean).toBe(false);
    // `name` is the row's key, not a WorkerConfig field — also dropped.
    expect('name' in clean).toBe(false);
  });
});

describe('GET /api/workers/status', () => {
  it('returns every known worker even when nothing has been written yet', async () => {
    using _live = await createLiveTestDatabase();
    const { ALL_KNOWN_WORKER_NAMES } = await import('./routes-status.ts');

    const body = await status();

    expect(Array.isArray(body.stages)).toBe(true);
    expect(body.stages).toHaveLength(ALL_KNOWN_WORKER_NAMES.length);
    for (const row of body.stages) expect(row['status']).toBe('stopped');
  });

  it('surfaces every stage the worker wrote, plus the statically known workers', async () => {
    using _live = await createLiveTestDatabase();
    const names = ['exif', 'thumb', 'preview', 'face-detect', 'describe', 'geocode', 'meili'];
    await writeWorkerStatus(snapshotOf(names), Date.now());

    const body = await status();

    const rows = body.stages as Array<{ name: string; status: string }>;
    const returned = new Set(rows.map((s) => s.name));
    for (const name of names) expect(returned.has(name)).toBe(true);
    for (const row of rows) {
      if (names.includes(row.name)) expect(row.status).toBe('stopped');
    }
  });

  it('zeroes every stage row before the worker has counted', async () => {
    using _live = await createLiveTestDatabase();
    await writeWorkerStatus(snapshotOf(['exif', 'thumb']), Date.now());

    const body = await status();

    const rows = (
      body.stages as Array<{
        name: string;
        pending: number;
        ready: number;
        blocked: number;
      }>
    ).filter((row) => (ALL_STAGE_NAMES as readonly string[]).includes(row.name));
    expect(rows.length).toBe(ALL_STAGE_NAMES.length);
    for (const row of rows) {
      expect(row.pending).toBe(0);
      expect(row.ready).toBe(0);
      expect(row.blocked).toBe(0);
    }
  });

  it('serves the counts the worker persisted, stamped with countsAt (#3491)', async () => {
    using live = await createLiveTestDatabase();
    // A backlog in the database that disagrees with the snapshot: if the route
    // ever counted for itself, these assets are what it would report instead.
    const libraryId = insertFolder(live.db);
    for (let i = 0; i < 3; i++) {
      const assetId = insertAsset(live.db);
      insertLocation(live.db, { assetId, libraryId, path: `dir-${i}` });
      live.db.run(`INSERT INTO stage_state (asset_id, stage) VALUES (?, 'exif')`, [assetId]);
    }
    await writeWorkerStatus(
      snapshotOf(['exif'], { status: 'running', targetVersion: 2 }),
      Date.now(),
    );
    const computedAt = Date.now();
    await writeStatusCounts({
      pending: { exif: 12, 'missing-reaper': 3 },
      ready: { exif: 5, 'missing-reaper': 3 },
      dead: { exif: 1 },
      damaged: 4,
      newly_hidden: 2,
      computed_at: computedAt,
      duration_ms: 17,
    });

    const body = await status();

    const byName = new Map(
      (body.stages as Array<{ name: string } & Record<string, unknown>>).map((s) => [s.name, s]),
    );
    expect(byName.get('exif')).toMatchObject({ pending: 12, ready: 5, blocked: 7, dead: 1 });
    expect(byName.get('missing-reaper')).toMatchObject({ pending: 3, ready: 3, blocked: 0 });
    expect(body.damaged).toBe(4);
    expect(body.newlyHiddenTotal).toBe(2);
    expect(body.countsAt).toBe(computedAt);
  });

  it('reports countsAt: null before the worker has ever counted', async () => {
    using _live = await createLiveTestDatabase();
    expect((await status()).countsAt).toBeNull();
  });

  it('pokes the worker demand flag so counts refresh while the page is watched', async () => {
    using _live = await createLiveTestDatabase();
    const { _resetDemandThrottleForTests, COUNTS_DEMAND_WINDOW_MS } =
      await import('./routes-status.ts');
    _resetDemandThrottleForTests();
    const before = Date.now();

    await status();

    expect(await readStatusCountsDemand()).toBeGreaterThanOrEqual(before + COUNTS_DEMAND_WINDOW_MS);
  });

  it("the migration row's pending is the enabled migrations' persisted remaining", async () => {
    using _live = await createLiveTestDatabase();
    const { patchMigrationState } = await import('./migration-config.repo.ts');
    await patchMigrationState('refile-backups', { enabled: true, remaining: 40 });
    await patchMigrationState('refile-legacy-daydir', { enabled: false, remaining: 99 });

    const body = await status();

    const row = (body.stages as Array<{ name: string; pending: number }>).find(
      (s) => s.name === 'migration',
    );
    expect(row?.pending).toBe(40);
  });

  it("surfaces a stage as 'error' when the worker wrote it that way", async () => {
    using _live = await createLiveTestDatabase();
    await writeWorkerStatus(
      snapshotOf(['face'], { status: 'error', lastError: 'ONNX model not found' }),
      Date.now(),
    );

    const body = await status();

    const face = (
      body.stages as Array<{ name: string; status: string; lastError: string | null }>
    ).find((s) => s.name === 'face');
    expect(face).toMatchObject({ status: 'error', lastError: 'ONNX model not found' });
  });
});

async function post(path: string): Promise<Response> {
  const app = new Elysia().use(workerRoutes());
  return app.handle(new Request(`http://localhost/api/workers/${path}`, { method: 'POST' }));
}

describe('pause and resume', () => {
  it('404s an unknown worker on both', async () => {
    expect((await post('nonexistent/pause')).status).toBe(404);
    expect((await post('nonexistent/resume')).status).toBe(404);
  });

  it('writes the paused flag the worker re-reads on its next tick', async () => {
    using _live = await createLiveTestDatabase();
    const repo = new WorkerConfigRepo();

    expect((await post('thumb/pause')).status).toBe(200);
    expect((await repo.load('thumb'))?.paused).toBe(true);

    expect((await post('thumb/resume')).status).toBe(200);
    expect((await repo.load('thumb'))?.paused).toBe(false);
  });

  it('clears a self-imposed pause reason on resume', async () => {
    using _live = await createLiveTestDatabase();
    const repo = new WorkerConfigRepo();
    await repo.patch('meili', { paused: true, pause_reason: 'embedder address rejected' });

    await post('meili/resume');

    // The reason describes the pause it arrived with, so a resume drops it —
    // cleared to NULL in the row, which reads back as an absent key.
    const cfg = await repo.load('meili');
    expect(cfg?.paused).toBe(false);
    expect(cfg?.pause_reason ?? null).toBeNull();
  });
});

describe('the dead-letter and damaged surfaces', () => {
  it('404s an unknown stage', async () => {
    const app = new Elysia().use(workerRoutes());
    expect((await post('nonexistent/retry-dead')).status).toBe(404);
    expect(
      (await app.handle(new Request('http://localhost/api/workers/nonexistent/dead'))).status,
    ).toBe(404);
  });

  it('lists a stage’s dead assets and re-queues them on retry', async () => {
    using live = await createLiveTestDatabase();
    const libraryId = insertFolder(live.db, { path: '/lib' });
    const assetId = insertAsset(live.db);
    insertLocation(live.db, { assetId, libraryId, path: 'a', filename: 'broken.dng' });
    live.db.run(
      `INSERT INTO stage_state (asset_id, stage, version, attempts, dead, last_error, processed_at)
       VALUES (?, 'exif', 0, 3, 1, 'Unknown file format', '2026-01-01T00:00:00Z')`,
      [assetId],
    );

    const app = new Elysia().use(workerRoutes());
    const listed = await (
      await app.handle(new Request('http://localhost/api/workers/exif/dead'))
    ).json();
    expect(listed.items).toHaveLength(1);
    expect(listed.items[0]).toMatchObject({
      id: assetId,
      abs_path: '/lib/a/broken.dng',
      last_error: 'Unknown file format',
      attempts: 3,
    });

    const retried = await (await post('exif/retry-dead')).json();
    expect(retried).toEqual({ ok: true, reset: 1 });
    const after = await (
      await app.handle(new Request('http://localhost/api/workers/exif/dead'))
    ).json();
    expect(after.items).toHaveLength(0);
  });

  it('lists damaged assets and clears the tag with the tagging stages', async () => {
    using live = await createLiveTestDatabase();
    const libraryId = insertFolder(live.db, { path: '/lib' });
    const assetId = insertAsset(live.db);
    insertLocation(live.db, { assetId, libraryId, path: 'a', filename: 'corrupt.cr2' });
    live.db.run(
      `UPDATE assets SET damaged_since = '2026-01-01T00:00:00Z', damaged_stage = 'exif',
              damaged_reason = 'Unknown file format', maple_id = 'abc' WHERE id = ?`,
      [assetId],
    );
    for (const stage of ['exif', 'thumb', 'preview']) {
      live.db.run(`INSERT INTO stage_state (asset_id, stage, attempts, dead) VALUES (?, ?, 3, 1)`, [
        assetId,
        stage,
      ]);
    }

    const app = new Elysia().use(workerRoutes());
    const listed = await (
      await app.handle(new Request('http://localhost/api/workers/damaged'))
    ).json();
    expect(listed.items).toHaveLength(1);
    expect(listed.items[0]).toMatchObject({
      id: assetId,
      maple_id: 'abc',
      abs_path: '/lib/a/corrupt.cr2',
      stage: 'exif',
      reason: 'Unknown file format',
    });

    const cleared = await (
      await app.handle(
        new Request('http://localhost/api/workers/damaged/clear', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ id: assetId }),
        }),
      )
    ).json();
    expect(cleared).toEqual({ ok: true, cleared: 1 });

    // Un-parked AND genuinely re-tried: the tag is gone and every tagging
    // stage's dead-letter went with it, which is the half that used to be a
    // separate write and could come apart.
    const row = live.db.query(`SELECT damaged_since FROM assets WHERE id = ?`).get(assetId) as {
      damaged_since: string | null;
    };
    expect(row.damaged_since).toBeNull();
    const stillDead = live.db
      .query(`SELECT COUNT(*) AS n FROM stage_state WHERE asset_id = ? AND dead = 1`)
      .get(assetId) as { n: number };
    expect(stillDead.n).toBe(0);
  });

  it('rejects a malformed asset id on clear rather than clearing everything', async () => {
    using _live = await createLiveTestDatabase();
    const app = new Elysia().use(workerRoutes());
    const res = await app.handle(
      new Request('http://localhost/api/workers/damaged/clear', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id: 'not-an-id' }),
      }),
    );
    expect(res.status).toBe(400);
  });
});

describe('PATCH /api/workers/:name/config', () => {
  it('returns 404 for an unknown stage', async () => {
    const res = await patch('nonexistent', { concurrency: 4 });
    expect(res.status).toBe(404);
  });

  // Register a fake live entry so the route's `has()` check passes and the body
  // schema, not the 404, is what gates the request.
  function registerFakeStage(name: string): void {
    stageRegistry._resetForTests();
    stageRegistry.register(name, {
      targetVersion: 1,
      dependsOn: [],
      getInFlight: () => 0,
      getThroughput: () => 0,
      getPaused: () => false,
      reloadConfig: async () => {},
      pause: async () => {},
      resume: async () => {},
    });
  }

  async function patch(name: string, body: unknown): Promise<Response> {
    const app = new Elysia().use(workerRoutes());
    return app.handle(
      new Request(`http://localhost/api/workers/${name}/config`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      }),
    );
  }

  it('rejects concurrency above the 100 ceiling (422)', async () => {
    registerFakeStage('thumb');
    expect((await patch('thumb', { concurrency: 101 })).status).toBe(422);
  });

  it('persists a config at the 100 ceiling and reads it back', async () => {
    using _live = await createLiveTestDatabase();
    registerFakeStage('thumb');

    const res = await patch('thumb', { concurrency: 100 });

    expect(res.status).toBe(200);
    expect((await res.json()).config).toMatchObject({ concurrency: 100 });
  });

  it('rejects the removed pollIntervalMs knob with 400', async () => {
    registerFakeStage('thumb');
    const res = await patch('thumb', { pollIntervalMs: 1000 });
    expect(res.status).toBe(400);
    expect(String((await res.json()).error)).toContain('pollIntervalMs');
  });

  it('rejects the removed batchSize knob with 400', async () => {
    registerFakeStage('thumb');
    const res = await patch('thumb', { batchSize: 5 });
    expect(res.status).toBe(400);
    expect(String((await res.json()).error)).toContain('batchSize');
  });
});
