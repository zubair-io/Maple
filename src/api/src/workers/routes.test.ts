import { describe, expect, it, beforeEach, beforeAll } from 'bun:test';
import { Elysia } from 'elysia';
import { workerRoutes, sanitizeWorkerConfig } from './routes.ts';
import type { WorkerConfigDoc } from './worker-config.repo.ts';
import { stageRegistry } from './registry.ts';
import { ALL_STAGE_NAMES } from './stages/manifest.ts';
import { writeWorkerStatus } from './worker-status.repo.ts';
import { WorkerConfigRepo } from './worker-config.repo.ts';
import { getDb } from '../db/client.ts';
import type { StageStatusSnapshot } from './registry.ts';

let dbReachable = true;
beforeAll(async () => {
  try {
    await getDb();
  } catch {
    dbReachable = false;
  }
});
beforeEach(async () => {
  if (dbReachable) {
    const db = await getDb();
    await db.collection('worker_status').deleteMany({ _id: 'singleton' });
    // `/status` derives each stage's pending/ready/dead from a live
    // countDocuments over the `assets` collection. In the shared CI Mongo an
    // earlier test file can leave asset docs behind, which makes the
    // "zeroed on empty DB" assertions observe a stale backlog. Clear assets so
    // every test in this file starts from a true 0/0/0 baseline.
    await db.collection('assets').deleteMany({});
  }
});

describe('sanitizeWorkerConfig', () => {
  it('strips removed knobs (pollIntervalMs / batchSize) from a stale config doc', () => {
    // A doc persisted before #674 still carries the removed knobs. The /status
    // route + WS status frame must NOT leak them back out.
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
    // `name` is a Mongo key, not a WorkerConfig field — also dropped.
    expect('name' in clean).toBe(false);
  });
});

describe('GET /api/workers/status', () => {
  it('returns all known workers even when worker_status has no doc', async () => {
    // No writeWorkerStatus call → readWorkerStatus returns null → statuses = {}
    // assembleWorkersStatus now unions ALL_KNOWN_WORKER_NAMES, so every worker
    // appears with status 'stopped' rather than an empty array.
    const { ALL_KNOWN_WORKER_NAMES } = await import('./routes-status.ts');
    const app = new Elysia().use(workerRoutes());

    const res = await app.handle(new Request('http://localhost/api/workers/status'));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toHaveProperty('stages');
    expect(Array.isArray(body.stages)).toBe(true);
    expect(body.stages).toHaveLength(ALL_KNOWN_WORKER_NAMES.length);
    for (const s of body.stages) {
      expect(s.status).toBe('stopped');
    }
  });

  // Regression test for PR #164 review issue 1: the worker writes snapshots for
  // every pre-registered stage (even those mid-retry / stopped) to worker_status.
  // The API reads that snapshot and surfaces all stage names. Since PR #892 the
  // response also includes every other known worker (missing-reaper, migration,
  // discover) even when the worker process is not running, so the check is now
  // a superset: all snapshot names appear, plus the static known names.
  it('surfaces stages written by the worker to worker_status', async () => {
    if (!dbReachable) return;
    const names = [
      'exif',
      'thumb',
      'preview',
      'face-detect',
      'face-embed',
      'describe',
      'geocode',
      'meili',
    ];
    const snapshot: Record<string, StageStatusSnapshot> = {};
    for (const n of names) {
      snapshot[n] = {
        status: 'stopped',
        inFlight: 0,
        throughput: 0,
        targetVersion: 1,
        dependsOn: [],
        lastError: null,
      };
    }
    await writeWorkerStatus(snapshot, Date.now());

    const app = new Elysia().use(workerRoutes());
    const res = await app.handle(new Request('http://localhost/api/workers/status'));
    expect(res.status).toBe(200);
    const body = await res.json();
    const returnedNames = new Set(
      (body.stages as Array<{ name: string; status: string }>).map((s) => s.name),
    );
    // All snapshot names must be present.
    for (const n of names) {
      expect(returnedNames.has(n)).toBe(true);
    }
    // Stages written by the worker carry their written status.
    for (const s of body.stages as Array<{ name: string; status: string }>) {
      if (names.includes(s.name)) {
        expect(s.status).toBe('stopped');
      }
    }
  });

  it('includes pending/ready/blocked on every stage row (zeroed on empty DB)', async () => {
    if (!dbReachable) return;
    const snapshot: Record<string, StageStatusSnapshot> = {
      exif: {
        status: 'running',
        inFlight: 0,
        throughput: 0,
        targetVersion: 2,
        dependsOn: [],
        lastError: null,
      },
      thumb: {
        status: 'running',
        inFlight: 0,
        throughput: 0,
        targetVersion: 2,
        dependsOn: [{ name: 'exif', minVersion: 1 }],
        lastError: null,
      },
    };
    await writeWorkerStatus(snapshot, Date.now());

    const app = new Elysia().use(workerRoutes());
    const res = await app.handle(new Request('http://localhost/api/workers/status'));
    const body = await res.json();
    const rows = body.stages as Array<{
      name: string;
      pending: number;
      ready: number;
      blocked: number;
    }>;
    // Only the asset-processing stages are zeroed on an empty assets DB. Non-stage
    // workers in the union (e.g. migration, whose `pending` is the unapplied-migration
    // count) have their own pending semantics and aren't asserted here.
    const stageRows = rows.filter((r) => (ALL_STAGE_NAMES as readonly string[]).includes(r.name));
    expect(stageRows.length).toBe(ALL_STAGE_NAMES.length);
    for (const r of stageRows) {
      expect(r).toHaveProperty('ready');
      expect(r).toHaveProperty('blocked');
      // Empty assets collection → counts are 0, blocked is clamped pending−ready.
      expect(r.pending).toBe(0);
      expect(r.ready).toBe(0);
      expect(r.blocked).toBe(0);
    }
  });

  it("surfaces a stage as 'error' when written that way by the worker", async () => {
    if (!dbReachable) return;
    const snapshot: Record<string, StageStatusSnapshot> = {
      face: {
        status: 'error',
        inFlight: 0,
        throughput: 0,
        targetVersion: 1,
        dependsOn: [],
        lastError: 'ONNX model not found',
      },
    };
    await writeWorkerStatus(snapshot, Date.now());

    const app = new Elysia().use(workerRoutes());
    const res = await app.handle(new Request('http://localhost/api/workers/status'));
    const body = await res.json();
    const face = (
      body.stages as Array<{
        name: string;
        status: string;
        lastError: string | null;
      }>
    ).find((s) => s.name === 'face');
    expect(face).toBeDefined();
    expect(face!.status).toBe('error');
    expect(face!.lastError).toBe('ONNX model not found');
  });
});

describe('POST /api/workers/:name/pause', () => {
  it('returns 404 for unknown stage', async () => {
    const app = new Elysia().use(workerRoutes());
    const res = await app.handle(
      new Request('http://localhost/api/workers/nonexistent/pause', {
        method: 'POST',
      }),
    );
    expect(res.status).toBe(404);
  });

  it('writes worker_config.paused=true (cross-process channel)', async () => {
    if (!dbReachable) return;
    const db = await getDb();
    // Clean up any prior doc.
    await db.collection('worker_config').deleteOne({ name: 'thumb' });

    const app = new Elysia().use(workerRoutes());
    const res = await app.handle(
      new Request('http://localhost/api/workers/thumb/pause', { method: 'POST' }),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);

    const repo = new WorkerConfigRepo(db.collection('worker_config') as never);
    const cfg = await repo.load('thumb');
    expect(cfg?.paused).toBe(true);

    await db.collection('worker_config').deleteOne({ name: 'thumb' });
  });
});

describe('POST /api/workers/:name/resume', () => {
  it('returns 404 for unknown stage', async () => {
    const app = new Elysia().use(workerRoutes());
    const res = await app.handle(
      new Request('http://localhost/api/workers/nonexistent/resume', {
        method: 'POST',
      }),
    );
    expect(res.status).toBe(404);
  });

  it('writes worker_config.paused=false (cross-process channel)', async () => {
    if (!dbReachable) return;
    const db = await getDb();
    // Seed a paused doc first.
    const repo = new WorkerConfigRepo(db.collection('worker_config') as never);
    await repo.patch('thumb', { paused: true });

    const app = new Elysia().use(workerRoutes());
    const res = await app.handle(
      new Request('http://localhost/api/workers/thumb/resume', { method: 'POST' }),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);

    const cfg = await repo.load('thumb');
    expect(cfg?.paused).toBe(false);

    await db.collection('worker_config').deleteOne({ name: 'thumb' });
  });
});

describe('POST /api/workers/:name/retry-dead', () => {
  it('returns 404 for unknown stage', async () => {
    const app = new Elysia().use(workerRoutes());
    const res = await app.handle(
      new Request('http://localhost/api/workers/nonexistent/retry-dead', {
        method: 'POST',
      }),
    );
    expect(res.status).toBe(404);
  });
});

describe('GET /api/workers/:name/dead', () => {
  it('returns 404 for unknown stage', async () => {
    const app = new Elysia().use(workerRoutes());
    const res = await app.handle(new Request('http://localhost/api/workers/nonexistent/dead'));
    expect(res.status).toBe(404);
  });
});

describe('PATCH /api/workers/:name/config', () => {
  it('returns 404 for unknown stage', async () => {
    const app = new Elysia().use(workerRoutes());
    const res = await app.handle(
      new Request('http://localhost/api/workers/nonexistent/config', {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ concurrency: 4 }),
      }),
    );
    expect(res.status).toBe(404);
  });

  // Register a fake live entry so the route's `has()` check passes and the
  // body schema (not the 404) is what gates the request.
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

  it('rejects concurrency above the new 100 ceiling (422)', async () => {
    registerFakeStage('thumb');
    const res = await patch('thumb', { concurrency: 101 });
    expect(res.status).toBe(422);
  });

  it('accepts concurrency at the new 100 ceiling (passes body validation)', async () => {
    registerFakeStage('thumb');
    const res = await patch('thumb', { concurrency: 100 });
    // No DB in this unit test, so the handler may 500 on getDb — but it must
    // NOT be the 422 a schema violation would produce. The point is the
    // 1–100 clamp now admits 100 (the old ceiling was 32).
    expect(res.status).not.toBe(422);
  });

  it('rejects the removed pollIntervalMs knob with 400', async () => {
    registerFakeStage('thumb');
    const res = await patch('thumb', { pollIntervalMs: 1000 });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(String(body.error)).toContain('pollIntervalMs');
  });

  it('rejects the removed batchSize knob with 400', async () => {
    registerFakeStage('thumb');
    const res = await patch('thumb', { batchSize: 5 });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(String(body.error)).toContain('batchSize');
  });
});

// --- #1290: deduplicate ready/pending count must be live-aware ---
// fetchStatusDbState's deduplicate count must exclude assets where the 2nd
// fileinfo entry is tombstoned (missing_since or deleted_at set), so the
// badge reflects what the worker can actually act on (and can reach 0).
describe('deduplicate count — fetchStatusDbState (#1290)', () => {
  it('does NOT count an asset with 1 live + 1 missing_since sibling', async () => {
    if (!dbReachable) return;
    const db = await getDb();
    const libraryId = new (await import('mongodb')).ObjectId();
    // Asset: one live entry + one tombstoned via missing_since.
    // The coarse predicate `fileinfo.1 exists` would count this; the live-aware
    // predicate must NOT.
    await db.collection('assets').insertOne({
      fileinfo: [
        { path: 'live', filename: 'IMG.dng', library_id: libraryId },
        {
          path: 'gone',
          filename: 'IMG.dng',
          library_id: libraryId,
          missing_since: '2026-01-01T00:00:00Z',
        },
      ],
      maple_id: 'b'.repeat(32),
      size: 1,
      mtime: 0,
      rating: 0,
      flag: 0,
      color_label: '',
      indexed_at: '2026-06-01T00:00:00Z',
      deleted_at: null,
      stages: {},
      live_location_count: 1,
    } as never);

    const { fetchStatusDbState, _resetStatusCacheForTests } = await import('./routes-status.ts');
    _resetStatusCacheForTests();
    const state = await fetchStatusDbState(['deduplicate'], {});
    const pending = state.pendingByStage.get('deduplicate') ?? 0;
    const ready = state.readyByStage.get('deduplicate') ?? 0;
    expect(pending).toBe(0);
    expect(ready).toBe(0);
  });

  it('does NOT count an asset with 1 live + 1 deleted_at sibling', async () => {
    if (!dbReachable) return;
    const db = await getDb();
    const libraryId = new (await import('mongodb')).ObjectId();
    await db.collection('assets').insertOne({
      fileinfo: [
        { path: 'live', filename: 'IMG.dng', library_id: libraryId },
        {
          path: 'replaced',
          filename: 'IMG.dng',
          library_id: libraryId,
          deleted_at: '2026-01-01T00:00:00Z',
        },
      ],
      maple_id: 'c'.repeat(32),
      size: 1,
      mtime: 0,
      rating: 0,
      flag: 0,
      color_label: '',
      indexed_at: '2026-06-01T00:00:00Z',
      deleted_at: null,
      stages: {},
      live_location_count: 1,
    } as never);

    const { fetchStatusDbState, _resetStatusCacheForTests } = await import('./routes-status.ts');
    _resetStatusCacheForTests();
    const state = await fetchStatusDbState(['deduplicate'], {});
    const pending = state.pendingByStage.get('deduplicate') ?? 0;
    const ready = state.readyByStage.get('deduplicate') ?? 0;
    expect(pending).toBe(0);
    expect(ready).toBe(0);
  });

  it('DOES count an asset with >=2 live entries', async () => {
    if (!dbReachable) return;
    const db = await getDb();
    const libraryId = new (await import('mongodb')).ObjectId();
    await db.collection('assets').insertOne({
      fileinfo: [
        { path: 'a', filename: 'IMG.dng', library_id: libraryId },
        { path: 'b', filename: 'IMG.dng', library_id: libraryId },
      ],
      maple_id: 'd'.repeat(32),
      size: 1,
      mtime: 0,
      rating: 0,
      flag: 0,
      color_label: '',
      indexed_at: '2026-06-01T00:00:00Z',
      deleted_at: null,
      stages: {},
      live_location_count: 2,
    } as never);

    const { fetchStatusDbState, _resetStatusCacheForTests } = await import('./routes-status.ts');
    _resetStatusCacheForTests();
    const state = await fetchStatusDbState(['deduplicate'], {});
    const pending = state.pendingByStage.get('deduplicate') ?? 0;
    const ready = state.readyByStage.get('deduplicate') ?? 0;
    expect(pending).toBe(1);
    expect(ready).toBe(1);
  });
});

describe('migration routes', () => {
  const app = new Elysia().use(workerRoutes());

  it('GET /migration/migrations lists the registry (works without DB)', async () => {
    const res = await app.handle(new Request('http://localhost/api/workers/migration/migrations'));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body.migrations)).toBe(true);
    const restructure = body.migrations.find((m: { id: string }) => m.id === 'refile-backups');
    expect(restructure).toBeDefined();
    expect(restructure).toMatchObject({
      title: expect.any(String),
      description: expect.any(String),
      enabled: expect.any(Boolean),
      status: expect.any(String),
    });
    const semanticBackfill = body.migrations.find(
      (m: { id: string }) => m.id === 'backfill-meilisearch-vectors',
    );
    expect(semanticBackfill).toMatchObject({
      title: 'Backfill semantic-search index',
      enabled: expect.any(Boolean),
      status: expect.any(String),
    });
  });

  it('PATCH /migration/migrations/:id → 404 for an unknown migration', async () => {
    const res = await app.handle(
      new Request('http://localhost/api/workers/migration/migrations/nope', {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ enabled: true }),
      }),
    );
    expect(res.status).toBe(404);
  });

  it('PATCH /migration/migrations/:id → 400 when neither enabled nor reset given', async () => {
    const res = await app.handle(
      new Request('http://localhost/api/workers/migration/migrations/refile-backups', {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({}),
      }),
    );
    expect(res.status).toBe(400);
  });

  it('Reset clears the semantic-backfill cursor as well as generic migration state', async () => {
    if (!dbReachable) return;
    const db = await getDb();
    await db.collection('meilisearch_backfill_state').insertOne({
      _id: 'assets',
      cursor: null,
      scanned: 10,
      completed_at: '2026-07-26T00:00:00.000Z',
    });

    const res = await app.handle(
      new Request(
        'http://localhost/api/workers/migration/migrations/backfill-meilisearch-vectors',
        {
          method: 'PATCH',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ reset: true }),
        },
      ),
    );

    expect(res.status).toBe(200);
    expect(await db.collection('meilisearch_backfill_state').findOne({ _id: 'assets' })).toBeNull();
  });
});
