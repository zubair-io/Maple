/**
 * The 409 a client is owed when its saved cursor predates the retained journal.
 *
 * Both transports have to answer it and they answer it from different places:
 * `/api/changes/subscribe` asks the in-memory ring buffer whether it can still
 * replay from that cursor, and `/api/changes` asks the journal itself. The Apple
 * side treats either 409 as `syncAnchorExpired` and re-enumerates, so a 200 over
 * a journal that has lost the rows in between is the failure this file exists to
 * catch — the client would advance its anchor past edits it never saw.
 *
 * ## What the cutover changed here
 *
 * The polling case used to seed its "already pruned" journal by writing the
 * counter document and the surviving rows straight into MongoDB. There is no
 * counter to write any more: `asset_changes.cursor` is an `INTEGER PRIMARY KEY`
 * and therefore a rowid alias, so allocation happens inside the insert and rows
 * are made with `recordAssetChange` / `recordAssetChangeRow`. The floor is then
 * produced the way production produces it — by running the retention sweep
 * (#3741) over the bottom of the journal — rather than by describing its
 * after-effects. The counter surviving that sweep is what lets an emptied
 * journal still report how far history went, so this asserts it explicitly
 * through `allocatedCursor`, which reads the counter and allocates nothing.
 *
 * The route reaches the database with no override, so each case installs a
 * migrated database as the process-wide handle and seeds through the same one.
 */

import { describe, expect, it, beforeEach, afterEach } from 'bun:test';
import { Elysia } from 'elysia';
import { ObjectId } from 'mongodb';
import { changesRoutes } from './changes.ts';
import { getChangeBus, __resetChangeBusForTests } from '../runtime/change-bus.ts';
import { __resetChangeFeedTailerForTests } from '../runtime/change-feed-tailer.ts';
import type { AssetChangeWithId } from '../db/schema.ts';
import { fakeAuth } from '../../tests/helpers/test-auth.ts';
import {
  allocatedCursor,
  recordAssetChange,
  recordAssetChangeRow,
} from '../db/sqlite/repos/changes.repo.ts';
import { pruneChangesBatch } from '../db/sqlite/repos/changes.retention.ts';
import {
  createLiveTestDatabase,
  type LiveTestDatabase,
} from '../db/sqlite/test-sqlite.test-helpers.ts';

let live: LiveTestDatabase;

/** An event for the bus alone — the SSE floor is a buffer, not the journal. */
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

/** Writes `count` journal rows and reports the cursors the inserts allocated. */
async function seedJournal(count: number): Promise<number[]> {
  const cursors: number[] = [];
  for (let i = 1; i <= count; i++) {
    cursors.push(
      await recordAssetChange(live.handle, {
        kind: 'update',
        asset_id: new ObjectId(),
        folder_id: new ObjectId(),
        abs_path: `/p/${i}.dng`,
        relative_path: `${i}.dng`,
      }),
    );
  }
  return cursors;
}

beforeEach(async () => {
  live = await createLiveTestDatabase();
  __resetChangeBusForTests();
  __resetChangeFeedTailerForTests();
});

afterEach(() => {
  __resetChangeBusForTests();
  __resetChangeFeedTailerForTests();
  live.close();
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
    const cursors = await seedJournal(105);
    expect(cursors.at(-1)).toBe(105);
    // The sweep production runs, over the bottom of the journal: cursors 1..100
    // go, 101..105 stay.
    const { deleted, prunedThrough } = await pruneChangesBatch(100, 100, live.handle);
    expect({ deleted, prunedThrough }).toEqual({ deleted: 100, prunedThrough: 100 });
    // The counter is not in the journal, so it still knows how far history went.
    // This is the number every 409 below names.
    expect(await allocatedCursor(live.handle)).toBe(105);

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

  it('returns 200 when the journal has unpruned rows starting from 1', async () => {
    const row = await recordAssetChangeRow(live.handle, {
      kind: 'create',
      asset_id: new ObjectId(),
      folder_id: new ObjectId(),
      abs_path: '/p/1.dng',
      relative_path: '1.dng',
    });
    expect(row.cursor).toBe(1);

    const app = new Elysia().use(fakeAuth()).use(changesRoutes);
    const res = await app.handle(new Request('http://localhost/api/changes?since=0'));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.changes.length).toBe(1);
    expect(body.changes[0].cursor).toBe(row.cursor);
    expect(body.changes[0].relative_path).toBe(row.relative_path);
  });
});
