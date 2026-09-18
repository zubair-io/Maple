/**
 * The ported tailer, and the hole the port closes.
 *
 * Most of this mirrors the Mongo suite: rows written by another process reach
 * the in-process bus, an event that already arrived in-process is not delivered
 * twice, and a restart leaves the bus knowing enough to refuse a stale cursor.
 *
 * The case worth reading is "a swept journal still refuses a dormant client".
 * Seeding the bus's high watermark from the journal's largest stored cursor —
 * what the Mongo tailer does — reports 0 once retention has emptied the table,
 * and `ChangeBus.isCursorReplayable` answers `since >= 0`, which is true for
 * every cursor any client could present. The client is told it is up to date,
 * gets an open stream carrying nothing, and silently never learns about the
 * changes the sweep removed.
 */

import { beforeEach, describe, expect, test } from 'bun:test';
import { ObjectId } from 'mongodb';
import { ChangeFeedTailer } from './change-feed-tailer.ts';
import { getChangeBus, __resetChangeBusForTests } from '../change-bus.ts';
import {
  recordAssetChange,
  type RecordChangeInput,
  type SqliteDb,
} from '../../db/sqlite/repos/changes.repo.ts';
import {
  createTestDatabase,
  run,
  testSqliteDb,
  type TestDatabase,
} from '../../db/sqlite/test-sqlite.test-helpers.ts';
import type { AssetChangeWithId } from '../../db/schema.ts';
import type { SqlParams, SqlRow } from '../../db/sqlite/protocol.ts';

beforeEach(__resetChangeBusForTests);

function change(overrides: Partial<RecordChangeInput> = {}): RecordChangeInput {
  return {
    kind: 'create',
    asset_id: new ObjectId(),
    folder_id: new ObjectId(),
    abs_path: '/srv/photos/a.dng',
    ...overrides,
  };
}

/** `n` change rows, as a worker in another process would have written them. */
async function seed(db: SqliteDb, n: number): Promise<void> {
  for (let i = 0; i < n; i++) await recordAssetChange(db, change({ abs_path: `/srv/${i}.dng` }));
}

/** A handle whose reads fail until {@link heal} is called. */
function brokenReads(inner: SqliteDb): SqliteDb & { heal: () => void } {
  let broken = true;
  return {
    read<T = SqlRow>(sql: string, params?: SqlParams): Promise<T[]> {
      if (broken) return Promise.reject(new Error('sqlite pool: reader worker is unavailable'));
      return inner.read<T>(sql, params);
    },
    write: inner.write.bind(inner),
    transaction: inner.transaction.bind(inner),
    heal: () => {
      broken = false;
    },
  };
}

/** A started tailer plus the handle it reads through. */
async function startedTailer(
  handle: TestDatabase,
): Promise<{ tailer: ChangeFeedTailer; db: SqliteDb }> {
  const db = testSqliteDb(handle.db);
  const tailer = new ChangeFeedTailer({ intervalMs: 10_000, db });
  await tailer.start();
  return { tailer, db };
}

describe('republishing', () => {
  test('republishes rows written by another process', async () => {
    using handle = await createTestDatabase();
    const { tailer, db } = await startedTailer(handle);
    try {
      await seed(db, 1);
      expect(await tailer.tickOnce()).toBe(1);
      const snapshot = getChangeBus().snapshot();
      expect(snapshot).toHaveLength(1);
      expect(snapshot[0]!.kind).toBe('create');
      expect(snapshot[0]!.abs_path).toBe('/srv/0.dng');
    } finally {
      tailer.stop();
    }
  });

  test('does not re-publish a row the local bus already has', async () => {
    using handle = await createTestDatabase();
    const { tailer, db } = await startedTailer(handle);
    try {
      const cursor = await recordAssetChange(db, change({ kind: 'update' }));
      // What `recordAndPublishAssetChange` does in the API process itself.
      getChangeBus().publish({
        _id: new ObjectId(),
        cursor,
        asset_id: null,
        folder_id: null,
        kind: 'update',
        abs_path: '/srv/photos/a.dng',
        relative_path: null,
        at: new Date(),
      } as AssetChangeWithId);

      await tailer.tickOnce();
      expect(getChangeBus().snapshot()).toHaveLength(1);
    } finally {
      tailer.stop();
    }
  });

  test('advances past what it republished, so a second tick is a no-op', async () => {
    using handle = await createTestDatabase();
    const { tailer, db } = await startedTailer(handle);
    try {
      await seed(db, 3);
      expect(await tailer.tickOnce()).toBe(3);
      expect(await tailer.tickOnce()).toBe(0);
      await seed(db, 1);
      expect(await tailer.tickOnce()).toBe(1);
      expect(
        getChangeBus()
          .snapshot()
          .map((event) => event.cursor),
      ).toEqual([1, 2, 3, 4]);
    } finally {
      tailer.stop();
    }
  });

  test('does not replay history it boots on top of', async () => {
    using handle = await createTestDatabase();
    const db = testSqliteDb(handle.db);
    await seed(db, 3);
    __resetChangeBusForTests();

    const tailer = new ChangeFeedTailer({ intervalMs: 10_000, db });
    await tailer.start();
    try {
      expect(await tailer.tickOnce()).toBe(0);
      expect(getChangeBus().snapshot()).toHaveLength(0);
    } finally {
      tailer.stop();
    }
  });
});

describe('the post-restart 409 decision', () => {
  test('refuses a cursor that predates the restart', async () => {
    using handle = await createTestDatabase();
    const db = testSqliteDb(handle.db);
    await seed(db, 3);
    __resetChangeBusForTests();

    const tailer = new ChangeFeedTailer({ intervalMs: 10_000, db });
    await tailer.start();
    try {
      const bus = getChangeBus();
      expect(bus.getPersistedHighWatermark()).toBe(3);
      expect(bus.isCursorReplayable(0)).toBe(false);
      expect(bus.isCursorReplayable(3)).toBe(true);
    } finally {
      tailer.stop();
    }
  });

  test('a swept journal still refuses a dormant client', async () => {
    using handle = await createTestDatabase();
    const db = testSqliteDb(handle.db);
    await seed(db, 3);
    // Retention pruning removes every row, then the process restarts.
    run(handle.db, `DELETE FROM asset_changes`);
    __resetChangeBusForTests();

    const tailer = new ChangeFeedTailer({ intervalMs: 10_000, db });
    await tailer.start();
    try {
      const bus = getChangeBus();
      // Seeded from `server_state.seq`, which the sweep does not touch. Seeding
      // from the journal's own maximum reports 0 here, and every assertion
      // below flips: the dormant client is told it is up to date.
      expect(bus.getPersistedHighWatermark()).toBe(3);
      expect(bus.isCursorReplayable(0)).toBe(false);
      expect(bus.isCursorReplayable(1)).toBe(false);
      expect(bus.isCursorReplayable(2)).toBe(false);
      // A client that had already seen everything before the sweep is fine.
      expect(bus.isCursorReplayable(3)).toBe(true);
    } finally {
      tailer.stop();
    }
  });

  test('a server that has never emitted a change replays from zero', async () => {
    using handle = await createTestDatabase();
    const { tailer } = await startedTailer(handle);
    try {
      expect(getChangeBus().getPersistedHighWatermark()).toBe(0);
      expect(getChangeBus().isCursorReplayable(0)).toBe(true);
    } finally {
      tailer.stop();
    }
  });

  test('a boot whose reads failed finishes seeding on the next tick', async () => {
    using handle = await createTestDatabase();
    const db = testSqliteDb(handle.db);
    await seed(db, 3);
    // The worst combination: a swept journal, so there is no row a later tick
    // could raise the watermark from, and a boot read that failed, so nothing
    // set it. Writing this off as "start from 0" leaves the bus permanently
    // unable to tell a dormant client to re-enumerate.
    run(handle.db, `DELETE FROM asset_changes`);
    __resetChangeBusForTests();

    const flaky = brokenReads(db);
    const tailer = new ChangeFeedTailer({ intervalMs: 10_000, db: flaky });
    await tailer.start();
    try {
      // start() swallowed the failure rather than throwing, so boot continues.
      expect(getChangeBus().getPersistedHighWatermark()).toBe(0);

      // The retry is the tick, and it converges as soon as the database
      // answers. Before it does, the tick propagates rather than republishing
      // from an unseeded mark.
      await expect(tailer.tickOnce()).rejects.toThrow(/unavailable/);
      flaky.heal();
      expect(await tailer.tickOnce()).toBe(0);

      const bus = getChangeBus();
      expect(bus.getPersistedHighWatermark()).toBe(3);
      expect(bus.isCursorReplayable(2)).toBe(false);
      expect(bus.isCursorReplayable(3)).toBe(true);
    } finally {
      tailer.stop();
    }
  });

  test('does not republish the journal it could not seed from', async () => {
    using handle = await createTestDatabase();
    const db = testSqliteDb(handle.db);
    await seed(db, 3);
    __resetChangeBusForTests();

    const flaky = brokenReads(db);
    const tailer = new ChangeFeedTailer({ intervalMs: 10_000, db: flaky });
    await tailer.start();
    try {
      // A tick that listed from an unseeded `localMax` of 0 would replay all
      // three rows to every connected client and then set the watermark from
      // the journal — the wrong number by exactly what retention removed.
      expect(getChangeBus().snapshot()).toHaveLength(0);
      flaky.heal();
      expect(await tailer.tickOnce()).toBe(0);
      expect(getChangeBus().snapshot()).toHaveLength(0);
      expect(getChangeBus().getPersistedHighWatermark()).toBe(3);
    } finally {
      tailer.stop();
    }
  });
});
