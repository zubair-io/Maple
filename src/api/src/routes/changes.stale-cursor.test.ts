import { describe, expect, it, beforeEach, afterEach } from 'bun:test';
import { Elysia } from 'elysia';
import { ObjectId } from 'mongodb';
import { changesRoutes } from './changes.ts';
import { getChangeBus, __resetChangeBusForTests } from '../runtime/change-bus.ts';
import type { AssetChangeWithId } from '../db/schema.ts';
import { fakeAuth } from '../../tests/helpers/test-auth.ts';
import { getDb, assetChangesCollection, serverStateCollection } from '../db/client.ts';

function evt(cursor: number): AssetChangeWithId {
  return {
    _id: new ObjectId(),
    cursor,
    asset_id: new ObjectId(),
    folder_id: new ObjectId(),
    kind: 'update',
    abs_path: `/p/${cursor}.dng`,
    at: new Date(),
  } as AssetChangeWithId;
}

beforeEach(async () => {
  __resetChangeBusForTests();
  try {
    const db = await getDb();
    await db.collection('asset_changes').deleteMany({});
    await db.collection('server_state').deleteOne({ _id: 'asset_changes_cursor' as never });
  } catch {
    // Ignore if DB unreachable
  }
});

afterEach(() => {
  __resetChangeBusForTests();
});

describe('GET /api/changes/subscribe (stale cursor)', () => {
  it('returns 409 when since is below buffer floor', async () => {
    const bus = getChangeBus();
    for (let i = 100; i < 110; i++) bus.publish(evt(i));
    const app = new Elysia().use(fakeAuth()).use(changesRoutes);
    const res = await app.handle(new Request('http://localhost/api/changes/subscribe?since=1'));
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error).toMatch(/too old/i);
    expect(body.current).toBeGreaterThanOrEqual(109);
  });

  it('returns 400 when since is negative', async () => {
    const app = new Elysia().use(fakeAuth()).use(changesRoutes);
    const res = await app.handle(new Request('http://localhost/api/changes/subscribe?since=-1'));
    expect(res.status).toBe(400);
  });
});

describe('GET /api/changes (polling stale cursor check)', () => {
  it('returns 409 when rows prior to since have been pruned', async () => {
    const coll = await assetChangesCollection();
    const stateColl = await serverStateCollection();
    // Simulate pruned table: cursors 1..100 were pruned; rows 101..105 exist
    await stateColl.updateOne(
      { _id: 'asset_changes_cursor' },
      { $set: { seq: 105 } },
      { upsert: true },
    );
    for (let c = 101; c <= 105; c++) {
      await coll.insertOne({
        cursor: c,
        asset_id: new ObjectId(),
        folder_id: new ObjectId(),
        kind: 'update',
        abs_path: `/p/${c}.dng`,
        relative_path: `${c}.dng`,
        at: new Date(),
      });
    }

    const app = new Elysia().use(fakeAuth()).use(changesRoutes);

    // since=50 is below lowest cursor (101): 50 + 1 < 101 -> 409
    const resStale = await app.handle(new Request('http://localhost/api/changes?since=50'));
    expect(resStale.status).toBe(409);
    const bodyStale = await resStale.json();
    expect(bodyStale.error).toMatch(/too old/i);
    expect(bodyStale.current).toBe(105);

    // since=0 is also below lowest cursor: 0 + 1 < 101 -> 409
    const resZero = await app.handle(new Request('http://localhost/api/changes?since=0'));
    expect(resZero.status).toBe(409);
    const bodyZero = await resZero.json();
    expect(bodyZero.error).toMatch(/too old/i);
    expect(bodyZero.current).toBe(105);

    // since=100 is valid: 100 + 1 >= 101 -> 200 with rows 101..105
    const resValid = await app.handle(new Request('http://localhost/api/changes?since=100'));
    expect(resValid.status).toBe(200);
    const bodyValid = await resValid.json();
    expect(bodyValid.changes.length).toBe(5);
    expect(bodyValid.changes[0].cursor).toBe(101);
    expect(bodyValid.next_cursor).toBe(105);

    // since=105 is up to date: 200 with empty changes
    const resCurrent = await app.handle(new Request('http://localhost/api/changes?since=105'));
    expect(resCurrent.status).toBe(200);
    const bodyCurrent = await resCurrent.json();
    expect(bodyCurrent.changes.length).toBe(0);
    expect(bodyCurrent.next_cursor).toBeUndefined();
  });

  it('returns 200 when collection has unpruned rows starting from 1', async () => {
    const coll = await assetChangesCollection();
    await coll.insertOne({
      cursor: 1,
      asset_id: new ObjectId(),
      folder_id: new ObjectId(),
      kind: 'create',
      abs_path: '/p/1.dng',
      relative_path: '1.dng',
      at: new Date(),
    });

    const app = new Elysia().use(fakeAuth()).use(changesRoutes);
    const res = await app.handle(new Request('http://localhost/api/changes?since=0'));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.changes.length).toBe(1);
    expect(body.changes[0].cursor).toBe(1);
  });
});
