/**
 * File Provider delta sync, end to end over SQLite.
 *
 * This subsystem's bugs have historically lived between the pieces rather than
 * inside them, so this file wires the real ones together and drives them the
 * way `ChangeFeedClient.swift` does: a worker writes a change to the database,
 * the tailer republishes it onto the process bus, and the product's own
 * `/api/changes/subscribe` route hands it to a client over SSE. Nothing here is
 * stubbed except the auth context.
 *
 * The SSE route reads the bus and never the database, which is why it can be
 * exercised against the SQLite port before the cutover (#3752) moves the
 * polling route's repository import. The poll half cannot be driven through
 * `/api/changes` yet for the same reason — that handler still reads Mongo — so
 * the last test here pins the ported repository's verdict against the live
 * route's, cursor for cursor, on the scenario where the two have to match.
 *
 * The loop under test is the recovery one, and it has three steps the Apple
 * client performs in order: it is refused with a 409, it re-enumerates its
 * working set, and it resumes from the cursor the 409 named. All three have to
 * work for a client that slept through a retention sweep to come back in sync —
 * a 409 naming a cursor the client cannot resume from is a reconnect loop, not
 * a recovery.
 */

import { beforeEach, expect, test } from 'bun:test';
import { Elysia } from 'elysia';
import { ObjectId } from 'mongodb';
import { changesRoutes } from '../../routes/changes.ts';
import { ChangeFeedTailer } from './change-feed-tailer.ts';
import { __resetChangeBusForTests } from '../change-bus.ts';
import {
  isChangeCursorTooOld,
  listChangesSince,
  recordAssetChange,
  recordAndPublishAssetChange,
  __resetFolderPathCacheForTests,
  type SqliteDb,
} from '../../db/sqlite/repos/changes.repo.ts';
import {
  createTestDatabase,
  insertFolder,
  run,
  testSqliteDb,
} from '../../db/sqlite/test-sqlite.test-helpers.ts';
import { fakeAuth } from '../../../tests/helpers/test-auth.ts';

const LIBRARY_ROOT = '/srv/photos';

beforeEach(() => {
  __resetChangeBusForTests();
  __resetFolderPathCacheForTests();
});

function app(): Elysia {
  return new Elysia().use(fakeAuth()).use(changesRoutes) as unknown as Elysia;
}

function subscribe(since: number): Promise<Response> {
  return app().handle(new Request(`http://localhost/api/changes/subscribe?since=${since}`));
}

/** Read the stream until `deadlineMs` elapses, returning the decoded text. */
async function readWhile(res: Response, deadlineMs: number): Promise<string> {
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  const deadline = Date.now() + deadlineMs;
  let out = '';
  try {
    while (Date.now() < deadline) {
      const remaining = deadline - Date.now();
      const timeout = new Promise<'TIMEOUT'>((resolve) =>
        setTimeout(() => resolve('TIMEOUT'), remaining),
      );
      const result = await Promise.race([reader.read(), timeout]);
      if (result === 'TIMEOUT' || result.done) break;
      const chunk = result.value;
      out += chunk instanceof Uint8Array ? decoder.decode(chunk, { stream: true }) : String(chunk);
    }
  } finally {
    try {
      await reader.cancel();
    } catch {
      // The generator may already have returned; the text read so far stands.
    }
  }
  return out;
}

/** The `data:` payloads carried by an SSE body, in arrival order. */
function frames(body: string): Array<Record<string, unknown>> {
  return body
    .split('\n')
    .filter((line) => line.startsWith('data: '))
    .map((line) => JSON.parse(line.slice('data: '.length)) as Record<string, unknown>);
}

/** A change written by a worker in another process — database only, no bus. */
function workerWrite(db: SqliteDb, libraryId: string, name: string): Promise<number> {
  return recordAssetChange(db, {
    kind: 'update',
    asset_id: new ObjectId(),
    folder_id: new ObjectId(libraryId),
    abs_path: `${LIBRARY_ROOT}/${name}`,
    relative_path: name,
  });
}

test('a worker write reaches a subscribed client, folder-relative path intact', async () => {
  using handle = await createTestDatabase();
  const db = testSqliteDb(handle.db);
  const libraryId = insertFolder(handle.db, { path: LIBRARY_ROOT });

  const tailer = new ChangeFeedTailer({ intervalMs: 10_000, db });
  await tailer.start();
  const res = await subscribe(0);
  expect(res.status).toBe(200);

  // The API process learns about a child process's write only through the
  // tailer, so drive one tick while the client is parked on the stream.
  setTimeout(() => {
    void recordAndPublishAssetChange(
      {
        kind: 'create',
        asset_id: new ObjectId(),
        folder_id: new ObjectId(libraryId),
        abs_path: `${LIBRARY_ROOT}/2024/holiday/IMG_1.dng`,
      },
      db,
    ).then(() => tailer.tickOnce());
  }, 20);

  const body = await readWhile(res, 400);
  tailer.stop();

  const [frame] = frames(body);
  expect(frame).toBeDefined();
  expect(frame!.cursor).toBe(1);
  expect(frame!.kind).toBe('create');
  // What the extension routes per-folder invalidation on.
  expect(frame!.relative_path).toBe('2024/holiday/IMG_1.dng');
  expect(frame!.abs_path).toBe(`${LIBRARY_ROOT}/2024/holiday/IMG_1.dng`);
  // The SSE `id:` is the cursor the client persists and reconnects with.
  expect(body).toContain('id: 1');
});

test('a client below the retention floor is refused, re-enumerates and resumes', async () => {
  using handle = await createTestDatabase();
  const db = testSqliteDb(handle.db);
  const libraryId = insertFolder(handle.db, { path: LIBRARY_ROOT });

  // A client syncs up to cursor 2 and then goes to sleep.
  for (const name of ['a.dng', 'b.dng', 'c.dng']) await workerWrite(db, libraryId, name);
  const clientCursor = 2;

  // Retention prunes the journal to nothing and the server restarts.
  run(handle.db, `DELETE FROM asset_changes`);
  __resetChangeBusForTests();
  const tailer = new ChangeFeedTailer({ intervalMs: 10_000, db });
  await tailer.start();

  // Step 1 — refused, and told where the server actually is.
  const refused = await subscribe(clientCursor);
  expect(refused.status).toBe(409);
  const stale = (await refused.json()) as { error: string; current: number };
  expect(stale.error).toMatch(/too old/i);
  // Not 0: `ChangeFeedClient` reads 0 as "no usable cursor", resets to
  // `since=0` and trips the same 409 forever.
  expect(stale.current).toBe(3);

  // Step 2 — the client re-enumerates its working set. The journal holds
  // nothing to replay, which is exactly why a full re-enumeration is the only
  // way back and why the 409 had to be raised at all.
  expect(await listChangesSince(db, { since: 0, limit: 1000 })).toEqual([]);

  // Step 3 — it resumes from the cursor the 409 named, and gets the deltas
  // that land afterwards.
  const resumed = await subscribe(stale.current);
  expect(resumed.status).toBe(200);
  setTimeout(() => {
    void workerWrite(db, libraryId, 'd.dng').then(() => tailer.tickOnce());
  }, 20);
  const body = await readWhile(resumed, 400);
  tailer.stop();

  expect(frames(body).map((frame) => frame.cursor)).toEqual([4]);
  expect(frames(body)[0]!.relative_path).toBe('d.dng');
});

test('the poll verdict matches the stream, cursor for cursor, after a sweep', async () => {
  using handle = await createTestDatabase();
  const db = testSqliteDb(handle.db);
  const libraryId = insertFolder(handle.db, { path: LIBRARY_ROOT });
  for (const name of ['a.dng', 'b.dng', 'c.dng']) await workerWrite(db, libraryId, name);

  run(handle.db, `DELETE FROM asset_changes`);
  __resetChangeBusForTests();
  const tailer = new ChangeFeedTailer({ intervalMs: 10_000, db });
  await tailer.start();

  // A swept journal is the one state where the two transports must give the
  // same answer: nothing is left for either to serve, so a client below the
  // allocation watermark has to re-enumerate whichever way it asked. The SSE
  // side is the product's own route; the poll side is what the cutover (#3752)
  // will point `/api/changes` at, and it is the half that is missing today.
  for (const since of [0, 1, 2, 3]) {
    const streamed = await subscribe(since);
    const polled = await isChangeCursorTooOld(db, since);
    expect(polled.tooOld).toBe(streamed.status === 409);
    if (streamed.status === 409) {
      const stale = (await streamed.json()) as { current: number };
      // Both have to name a cursor the client can resume from — 0 is the one
      // value `ChangeFeedClient` cannot use.
      expect(polled.current).toBe(stale.current);
      expect(polled.current).toBe(3);
    } else {
      try {
        await streamed.body?.cancel();
      } catch {
        // Already closed.
      }
    }
  }
  tailer.stop();
});

test('a caught-up client is not refused after a sweep', async () => {
  using handle = await createTestDatabase();
  const db = testSqliteDb(handle.db);
  const libraryId = insertFolder(handle.db, { path: LIBRARY_ROOT });
  for (const name of ['a.dng', 'b.dng']) await workerWrite(db, libraryId, name);

  run(handle.db, `DELETE FROM asset_changes`);
  __resetChangeBusForTests();
  const tailer = new ChangeFeedTailer({ intervalMs: 10_000, db });
  await tailer.start();

  const res = await subscribe(2);
  tailer.stop();
  expect(res.status).toBe(200);
  try {
    await res.body?.cancel();
  } catch {
    // Already closed.
  }
});
