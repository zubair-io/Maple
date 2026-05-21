import { describe, expect, it } from 'bun:test';
import { Elysia } from 'elysia';
import { workerRoutes } from './routes.ts';
import { stageRegistry } from './registry.ts';

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
    const names = ['exif', 'thumb', 'preview', 'face', 'describe', 'geocode', 'meili'];
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

  it("surfaces a pre-registered stage as 'error' once recordError fires", async () => {
    stageRegistry._resetForTests();
    stageRegistry.preregister('face', 1);
    stageRegistry.recordError('face', 'ONNX model not found');
    const app = new Elysia().use(workerRoutes());
    const res = await app.handle(new Request('http://localhost/api/workers/status'));
    const body = await res.json();
    const face = (
      body.stages as Array<{ name: string; status: string; lastError: string | null }>
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
      new Request('http://localhost/api/workers/nonexistent/pause', { method: 'POST' }),
    );
    expect(res.status).toBe(404);
  });
});

describe('POST /api/workers/:name/resume', () => {
  it('returns 404 for unknown stage', async () => {
    const app = new Elysia().use(workerRoutes());
    const res = await app.handle(
      new Request('http://localhost/api/workers/nonexistent/resume', { method: 'POST' }),
    );
    expect(res.status).toBe(404);
  });
});

describe('POST /api/workers/:name/retry-dead', () => {
  it('returns 404 for unknown stage', async () => {
    const app = new Elysia().use(workerRoutes());
    const res = await app.handle(
      new Request('http://localhost/api/workers/nonexistent/retry-dead', { method: 'POST' }),
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
});
