/**
 * Integration tests for /api/workers/status performance + correctness.
 *
 * Skip-passes when MongoDB is unreachable so CI without a Mongo container
 * stays green — same pattern as tests/search-route.test.ts.
 */

import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import { MongoClient } from 'mongodb';

const TEST_DB = `maple_test_workers_status_${process.pid}`;
const PRIOR_MONGO_DB = process.env.MAPLE_MONGO_DB;
process.env.MAPLE_MONGO_DB = TEST_DB;

const MONGO_URI = process.env.MAPLE_MONGO_URI ?? 'mongodb://localhost:27017';

let mongo: MongoClient | null = null;
let mongoReachable = false;

beforeAll(async () => {
  try {
    mongo = new MongoClient(MONGO_URI, { serverSelectionTimeoutMS: 500 });
    await mongo.connect();
    await mongo.db('admin').command({ ping: 1 });
    mongoReachable = true;
  } catch {
    mongoReachable = false;
    // Close the partially-connected client so its server-selection timer
    // and any open sockets don't keep the test process alive. afterAll
    // only closes on the reachable path.
    if (mongo) {
      try {
        await mongo.close();
      } catch {}
      mongo = null;
    }
  }
});

afterAll(async () => {
  if (mongo && mongoReachable) {
    try {
      await mongo.db(TEST_DB).dropDatabase();
    } catch {}
    await mongo.close();
  }
  if (PRIOR_MONGO_DB === undefined) delete process.env.MAPLE_MONGO_DB;
  else process.env.MAPLE_MONGO_DB = PRIOR_MONGO_DB;
});

describe('ensureStageIndexes — dead partial index', () => {
  it('creates stage_<name>_dead partial index for every stage', async () => {
    if (!mongoReachable) return;
    const { closeDb, ensureStageIndexes } = await import('../src/db/client.ts');
    await closeDb();
    const db = mongo!.db(TEST_DB);
    // Pre-create the assets collection so dropIndex on a fresh namespace
    // doesn't throw NamespaceNotFound (matches the pattern in
    // tests/search-route.test.ts:1310).
    try {
      await db.createCollection('assets');
    } catch {}

    await ensureStageIndexes(db);
    // Idempotent — second call must not throw.
    await ensureStageIndexes(db);

    const indexes = await db.collection('assets').indexes();
    const byName = new Map(indexes.map((i) => [i.name as string, i]));

    for (const name of ['exif', 'thumb', 'preview', 'face', 'describe', 'geocode', 'meili']) {
      const idx = byName.get(`stage_${name}_dead`);
      expect(idx).toBeDefined();
      // Partial filter must restrict to dead: true so the index stays tiny.
      expect(idx?.partialFilterExpression).toEqual({
        [`stages.${name}.dead`]: true,
      });
    }
  });
});

describe('GET /api/workers/status — counts', () => {
  it('returns correct pending + dead counts using indexed queries', async () => {
    if (!mongoReachable) return;

    const { closeDb, ensureStageIndexes, getDb } = await import('../src/db/client.ts');
    await closeDb();
    const db = mongo!.db(TEST_DB);
    try {
      await db.dropCollection('assets');
    } catch {}
    try {
      await db.dropCollection('worker_config');
    } catch {}
    await db.createCollection('assets');
    await ensureStageIndexes(db);

    // Seed 6 docs against a single stage so we have a deterministic shape.
    //   - 2 docs with version < tv, dead != true  → pending
    //   - 1 doc  with version field absent        → pending
    //   - 2 docs with version == tv               → up-to-date (not counted)
    //   - 1 doc  with dead = true                 → dead
    const tv = 3;
    await db.collection('assets').insertMany([
      { stages: { exif: { version: 1 } } },
      { stages: { exif: { version: 2 } } },
      { stages: {} }, // no stages.exif at all → pending
      { stages: { exif: { version: tv } } },
      { stages: { exif: { version: tv } } },
      { stages: { exif: { version: 1, dead: true } } },
    ]);

    // Register a fake exif stage in the in-process registry so the route's
    // status loop knows what targetVersion to count against. `hash` was the
    // original stand-in but the stage was retired in PR 7 — any registered
    // stage works for this perf-shape test. Wrapped in try/finally so a
    // thrown assertion below can't leak the registration into later route
    // tests (the registry is a process-wide singleton).
    const { Elysia } = await import('elysia');
    const { workerRoutes } = await import('../src/workers/routes.ts');
    const { stageRegistry } = await import('../src/workers/registry.ts');
    stageRegistry.register('exif', {
      targetVersion: tv,
      getInFlight: () => 0,
      getThroughput: () => 0,
      getPaused: () => false,
      reloadConfig: async () => {},
      pause: async () => {},
      resume: async () => {},
    });

    try {
      // Force the route's getDb() to point at TEST_DB.
      process.env.MAPLE_MONGO_DB = TEST_DB;
      await closeDb();
      await getDb();

      const app = new Elysia().use(workerRoutes());
      const res = await app.handle(new Request('http://localhost/api/workers/status'));
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        stages: Array<{ name: string; pending: number; dead: number }>;
      };
      const exif = body.stages.find((s) => s.name === 'exif');
      expect(exif).toBeDefined();
      expect(exif!.pending).toBe(3);
      expect(exif!.dead).toBe(1);
    } finally {
      // Tear down the fake registration so it doesn't leak into other tests
      // even if an assertion above threw.
      stageRegistry.unregister('exif');
    }
  });

  it('uses an index plan (no COLLSCAN) for the dead-count query', async () => {
    if (!mongoReachable) return;
    const { closeDb, ensureStageIndexes } = await import('../src/db/client.ts');
    await closeDb();
    const db = mongo!.db(TEST_DB);
    try {
      await db.createCollection('assets');
    } catch {}
    await ensureStageIndexes(db);
    // Self-seed so the test doesn't depend on data left by a prior test.
    // `exif` stands in for any live worker stage — the `hash` stage was
    // retired in PR 7 so its indexes are no longer created.
    await db.collection('assets').insertOne({ stages: { exif: { dead: true } } });

    const explain = await db
      .collection('assets')
      .find({ 'stages.exif.dead': true })
      .explain('queryPlanner');
    const winning = JSON.stringify(explain.queryPlanner?.winningPlan ?? {});
    expect(winning).not.toContain('COLLSCAN');
    expect(winning).toContain('stage_exif_dead');
  });

  it('uses an index plan (no COLLSCAN) for the pending-count query', async () => {
    if (!mongoReachable) return;
    const { closeDb, ensureStageIndexes } = await import('../src/db/client.ts');
    await closeDb();
    const db = mongo!.db(TEST_DB);
    try {
      await db.createCollection('assets');
    } catch {}
    await ensureStageIndexes(db);

    // Seed at least one document so the planner has data to plan against.
    // A doc with no stages.exif field exercises the $exists:false branch
    // of the pending query and forces the planner to consider the version index.
    await db.collection('assets').insertOne({ stages: {} });

    const tv = 3;
    const explain = await db
      .collection('assets')
      .find({
        $or: [
          { 'stages.exif.version': { $lt: tv } },
          { 'stages.exif.version': { $exists: false } },
        ],
        'stages.exif.dead': { $ne: true },
      })
      .explain('queryPlanner');
    const winning = JSON.stringify(explain.queryPlanner?.winningPlan ?? {});
    expect(winning).not.toContain('COLLSCAN');
    expect(winning).toContain('stage_exif_version');
  });
});
