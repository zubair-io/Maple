import { describe, expect, it } from 'bun:test';
import { Elysia } from 'elysia';
import { workerRoutes, sanitizeWorkerConfig } from './routes.ts';
import type { WorkerConfigDoc } from './worker-config.repo.ts';
import { stageRegistry } from './registry.ts';

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
  it('returns an empty stages array when the registry has no stages', async () => {
    stageRegistry._resetForTests();
    const app = new Elysia().use(workerRoutes());

    const res = await app.handle(new Request('http://localhost/api/workers/status'));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toHaveProperty('stages');
    expect(Array.isArray(body.stages)).toBe(true);
    expect(body.stages).toHaveLength(0);
  });

  // Regression test for PR #164 review issue 1: a stage whose bootConfig
  // is still mid-retry must still surface in `/status` so operators can
  // see (and recover) the failure via the UI. Pre-registration ensures
  // every stage the orchestrator plans to start is visible from the very
  // first /status call, even before any stage has booted.
  it("surfaces pre-registered stages as 'stopped' even when none have booted", async () => {
    stageRegistry._resetForTests();
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
    for (const n of names) stageRegistry.preregister(n, 1);
    const app = new Elysia().use(workerRoutes());
    const res = await app.handle(new Request('http://localhost/api/workers/status'));
    expect(res.status).toBe(200);
    const body = await res.json();
    const stageNames = (body.stages as Array<{ name: string; status: string }>)
      .map((s) => s.name)
      .sort();
    expect(stageNames).toEqual(names.sort());
    for (const s of body.stages) {
      expect(s.status).toBe('stopped');
    }
  });

  it('includes pending/ready/blocked on every stage row (zeroed when the DB is unavailable)', async () => {
    stageRegistry._resetForTests();
    stageRegistry.preregister('exif', 2);
    stageRegistry.preregister('thumb', 2, [{ name: 'exif', minVersion: 1 }]);
    const app = new Elysia().use(workerRoutes());
    const res = await app.handle(new Request('http://localhost/api/workers/status'));
    const body = await res.json();
    const rows = body.stages as Array<{
      name: string;
      pending: number;
      ready: number;
      blocked: number;
    }>;
    for (const r of rows) {
      expect(r).toHaveProperty('ready');
      expect(r).toHaveProperty('blocked');
      // No DB in this unit test → counts fall back to 0, and blocked is the
      // clamped pending − ready difference.
      expect(r.pending).toBe(0);
      expect(r.ready).toBe(0);
      expect(r.blocked).toBe(0);
    }
  });

  it("surfaces a pre-registered stage as 'error' once recordError fires", async () => {
    stageRegistry._resetForTests();
    stageRegistry.preregister('face', 1);
    stageRegistry.recordError('face', 'ONNX model not found');
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
    expect(stageRegistry.has('nonexistent')).toBe(false);
    const app = new Elysia().use(workerRoutes());
    const res = await app.handle(
      new Request('http://localhost/api/workers/nonexistent/pause', {
        method: 'POST',
      }),
    );
    expect(res.status).toBe(404);
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

describe('migration routes', () => {
  const app = new Elysia().use(workerRoutes());

  it('GET /migration/migrations lists the registry (works without DB)', async () => {
    const res = await app.handle(new Request('http://localhost/api/workers/migration/migrations'));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body.migrations)).toBe(true);
    const restructure = body.migrations.find(
      (m: { id: string }) => m.id === 'restructure-backup-folders',
    );
    expect(restructure).toBeDefined();
    expect(restructure).toMatchObject({
      title: expect.any(String),
      description: expect.any(String),
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
      new Request('http://localhost/api/workers/migration/migrations/restructure-backup-folders', {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({}),
      }),
    );
    expect(res.status).toBe(400);
  });
});
