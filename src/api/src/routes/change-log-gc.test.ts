import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { Elysia } from 'elysia';
import { ObjectId, type Db } from 'mongodb';
import { changeLogGcRoutes } from './change-log-gc.ts';
import { changesRoutes } from './changes.ts';
import { closeDb, getDb, isDbConnected } from '../db/client.ts';
import { withTestDb } from '../db/test-db.test-helpers.ts';
import { fakeAuth } from '../../tests/helpers/test-auth.ts';
import { allocateCursor, recordAssetChange } from '../db/changes.repo.ts';
import { runChangeLogGcOnce } from '../workers/change-log-gc.ts';
import { saveChangeLogGcConfig } from '../workers/change-log-gc-config.repo.ts';

withTestDb(`maple_test_change_log_gc_routes_${process.pid}`);

const DAY_MS = 86_400_000;

let db: Db | null = null;
let app: Pick<Elysia, 'handle'> | null = null;
let mongoReachable = false;

beforeAll(async () => {
  await closeDb();
});

beforeEach(async () => {
  try {
    db = await getDb();
    mongoReachable = isDbConnected();
  } catch {
    mongoReachable = false;
    return;
  }
  if (!db) return;
  await db.collection('asset_changes').deleteMany({});
  await db.collection('server_state').deleteMany({});
  await db.collection('worker_config').deleteMany({});
  app = new Elysia().use(fakeAuth()).use(changeLogGcRoutes).use(changesRoutes);
});

afterAll(async () => {
  if (db) await db.dropDatabase();
  await closeDb();
});

describe('/api/change-log-gc', () => {
  it('reports the defaults before anything has been configured', async () => {
    if (!mongoReachable || !app) return;
    const res = await app.handle(new Request('http://localhost/api/change-log-gc/status'));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.config.enabled).toBe(true);
    expect(body.config.retention_days).toBe(30);
    expect(body.rows).toBe(0);
    expect(body.pruned_through).toBe(0);
  });

  it('persists a retention-window edit and reads it straight back', async () => {
    if (!mongoReachable || !app) return;
    const put = await app.handle(
      new Request('http://localhost/api/change-log-gc/config', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ retention_days: 7, enabled: false }),
      }),
    );
    expect(put.status).toBe(200);
    expect((await put.json()).config.retention_days).toBe(7);

    const status = await app.handle(new Request('http://localhost/api/change-log-gc/status'));
    const body = await status.json();
    expect(body.config.retention_days).toBe(7);
    expect(body.config.enabled).toBe(false);
  });

  it('rejects a window outside the accepted range', async () => {
    if (!mongoReachable || !app) return;
    const res = await app.handle(
      new Request('http://localhost/api/change-log-gc/config', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ retention_days: 0 }),
      }),
    );
    expect(res.status).toBe(422);
  });
});

describe('GET /api/changes after a sweep', () => {
  it('answers 409 to a cursor the sweep pruned past, and serves a fresh one', async () => {
    if (!mongoReachable || !db || !app) return;
    await saveChangeLogGcConfig({ retention_days: 30 });

    // Three rows the client already saw, aged out of the window, plus one
    // inside it. Age lives in the `_id` — the field the sweep filters on — and
    // `_id` is immutable once written, so the old rows are inserted with an
    // aged id from the start. Their cursors still come from the real allocator.
    const agedSecond = Math.floor((Date.now() - 90 * DAY_MS) / 1000);
    const stale: number[] = [];
    for (let i = 0; i < 3; i++) {
      const cursor = await allocateCursor();
      stale.push(cursor);
      await db.collection('asset_changes').insertOne({
        _id: ObjectId.createFromTime(agedSecond + i),
        cursor,
        asset_id: new ObjectId(),
        folder_id: null,
        kind: 'update',
        abs_path: `/lib/old-${i}.dng`,
        relative_path: null,
        at: new Date(agedSecond * 1000),
      } as never);
    }
    const fresh = await recordAssetChange(undefined, {
      kind: 'update',
      asset_id: new ObjectId(),
      folder_id: null,
      abs_path: '/lib/new.dng',
    });

    const summary = await runChangeLogGcOnce({ pauseMs: 0 });
    expect(summary.deleted).toBe(3);

    // A client parked on a cursor from before the sweep is told to start over.
    const stalest = stale[0]! - 1;
    const staleRes = await app.handle(new Request(`http://localhost/api/changes?since=${stalest}`));
    expect(staleRes.status).toBe(409);
    const staleBody = await staleRes.json();
    expect(staleBody.error).toMatch(/too old/i);
    expect(staleBody.current).toBe(summary.prunedThrough);

    // A client already past the floor is served normally.
    const okRes = await app.handle(
      new Request(`http://localhost/api/changes?since=${summary.prunedThrough}`),
    );
    expect(okRes.status).toBe(200);
    const okBody = await okRes.json();
    expect(okBody.changes.map((c: { cursor: number }) => c.cursor)).toEqual([fresh]);
  });

  it('serves every cursor normally while nothing has been pruned', async () => {
    if (!mongoReachable || !app) return;
    const cursor = await recordAssetChange(undefined, {
      kind: 'update',
      asset_id: new ObjectId(),
      folder_id: null,
      abs_path: '/lib/a.dng',
    });
    const res = await app.handle(new Request('http://localhost/api/changes?since=0'));
    expect(res.status).toBe(200);
    expect((await res.json()).changes.map((c: { cursor: number }) => c.cursor)).toEqual([cursor]);
  });
});
