import { describe, expect, it, beforeAll, beforeEach, afterEach } from 'bun:test';
import { Elysia } from 'elysia';
import { ObjectId } from 'mongodb';
import { changesRoutes } from './changes.ts';
import { getChangeBus, __resetChangeBusForTests } from '../runtime/change-bus.ts';
import { __resetChangeFeedTailerForTests } from '../runtime/change-feed-tailer.ts';
import type { AssetChangeWithId } from '../db/schema.ts';
import { fakeAuth } from '../../tests/helpers/test-auth.ts';
import { closeDb, getDb, assetChangesCollection } from '../db/client.ts';
import { raiseChangeLogPruneFloor } from '../db/changes.repo.ts';
import { withTestDb } from '../db/test-db.test-helpers.ts';

// Empties `asset_changes` and `server_state` between tests — both live on a
// throwaway database so a local run can't wipe the developer's real journal
// (#2783).
withTestDb(`maple_test_changes_stale_cursor_${process.pid}`);

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

beforeAll(async () => {
  await closeDb();
});

beforeEach(async () => {
  __resetChangeBusForTests();
  __resetChangeFeedTailerForTests();
  const db = await getDb();
  await db.collection('asset_changes').deleteMany({});
  await db.collection('server_state').deleteMany({});
});

afterEach(() => {
  __resetChangeBusForTests();
  __resetChangeFeedTailerForTests();
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

async function seedRows(cursors: number[]): Promise<void> {
  const coll = await assetChangesCollection();
  await coll.insertMany(
    cursors.map((cursor) => ({
      cursor,
      asset_id: new ObjectId(),
      folder_id: new ObjectId(),
      kind: 'update' as const,
      abs_path: `/p/${cursor}.dng`,
      relative_path: `${cursor}.dng`,
      at: new Date(),
    })),
  );
}

describe('GET /api/changes (polling stale cursor check)', () => {
  it('returns 409 when the retention sweep has pruned past since', async () => {
    await seedRows([101, 102, 103, 104, 105]);
    await raiseChangeLogPruneFloor(undefined, 100);

    const app = new Elysia().use(fakeAuth()).use(changesRoutes);

    const resStale = await app.handle(new Request('http://localhost/api/changes?since=50'));
    expect(resStale.status).toBe(409);
    const bodyStale = await resStale.json();
    expect(bodyStale.error).toMatch(/too old/i);
    expect(bodyStale.current).toBe(105);

    const resZero = await app.handle(new Request('http://localhost/api/changes?since=0'));
    expect(resZero.status).toBe(409);
    expect((await resZero.json()).current).toBe(105);

    // since=100 sits exactly on the floor: everything above it survives.
    const resValid = await app.handle(new Request('http://localhost/api/changes?since=100'));
    expect(resValid.status).toBe(200);
    const bodyValid = await resValid.json();
    expect(bodyValid.changes.length).toBe(5);
    expect(bodyValid.changes[0].cursor).toBe(101);
    expect(bodyValid.next_cursor).toBe(105);

    const resCurrent = await app.handle(new Request('http://localhost/api/changes?since=105'));
    expect(resCurrent.status).toBe(200);
    const bodyCurrent = await resCurrent.json();
    expect(bodyCurrent.changes.length).toBe(0);
    expect(bodyCurrent.next_cursor).toBeUndefined();
  });

  /**
   * The mid-sweep window, reproduced exactly: change-log-gc has claimed
   * everything up to cursor 105 and has not yet deleted a single row. A client
   * anchored inside that range must be turned away now, while the rows are
   * still on disk — if it is served them and saves 105 as its anchor, the
   * deletes that follow take events it will never ask for again.
   */
  it('409s a cursor the sweep has claimed, even before its rows are gone', async () => {
    await seedRows([1, 2, 3, 4, 5, 101, 102]);
    await raiseChangeLogPruneFloor(undefined, 105);

    const app = new Elysia().use(fakeAuth()).use(changesRoutes);
    const res = await app.handle(new Request('http://localhost/api/changes?since=2'));
    expect(res.status).toBe(409);
    expect((await res.json()).error).toMatch(/too old/i);
  });

  /**
   * A cursor gap is not a prune. `recordAssetChangeRow` allocates the cursor
   * and inserts the row as two steps, so an insert that fails leaves a
   * permanent hole — including at the very bottom of the journal. A brand-new
   * File Provider domain starts at since=0; it must not be told its anchor
   * expired on its first call just because cursor 1 leaked, on a library where
   * nothing has ever been pruned.
   */
  it('does not 409 on a leaked-cursor gap at the bottom of the journal', async () => {
    await seedRows([2, 3, 4]);

    const app = new Elysia().use(fakeAuth()).use(changesRoutes);
    const res = await app.handle(new Request('http://localhost/api/changes?since=0'));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.changes.map((c: { cursor: number }) => c.cursor)).toEqual([2, 3, 4]);
  });

  it('returns 200 when collection has unpruned rows starting from 1', async () => {
    await seedRows([1]);

    const app = new Elysia().use(fakeAuth()).use(changesRoutes);
    const res = await app.handle(new Request('http://localhost/api/changes?since=0'));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.changes.length).toBe(1);
    expect(body.changes[0].cursor).toBe(1);
  });

  /**
   * An emptied journal with cursors already handed out means rows existed and
   * are gone. With no floor to say who removed them, assume the worst.
   */
  it('409s an empty journal whose allocator has moved past since', async () => {
    const { allocateCursor } = await import('../db/changes.repo.ts');
    for (let i = 0; i < 7; i++) await allocateCursor();

    const app = new Elysia().use(fakeAuth()).use(changesRoutes);
    const res = await app.handle(new Request('http://localhost/api/changes?since=3'));
    expect(res.status).toBe(409);
    expect((await res.json()).current).toBe(7);
  });
});
