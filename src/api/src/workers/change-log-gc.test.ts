import { describe, expect, it, beforeAll, beforeEach } from 'bun:test';
import { ObjectId, type Db } from 'mongodb';
import { closeDb, getDb, assetChangesCollection, serverStateCollection } from '../db/client.ts';
import { withTestDb } from '../db/test-db.test-helpers.ts';
import type { AssetChangeDoc } from '../db/schema.ts';
import {
  findRetentionCutoffCursor,
  runChangeLogGcOnce,
  startChangeLogGc,
} from './change-log-gc.ts';
import { allocateCursor, changeLogPruneFloor } from '../db/changes.repo.ts';

// This suite empties `asset_changes` and `$inc`s the live cursor counter, so it
// must never be pointed at the default `maple` database — running it on a
// machine with the documented self-hosted stack would destroy the developer's
// real change journal. Scope it to a throwaway database of its own, the same
// way `trash-gc.test.ts` and `routes/change-log-gc.test.ts` do (#2783).
withTestDb(`maple_test_change_log_gc_${process.pid}`);

const DAY_MS = 86_400_000;

describe('change-log-gc', () => {
  // `withTestDb` registers its env override first, so this runs after it —
  // dropping any connection opened against the default database before the
  // override landed.
  beforeAll(async () => {
    await closeDb();
  });

  beforeEach(async () => {
    const db = await getDb();
    await db.collection('asset_changes').deleteMany({});
    await db.collection('server_state').deleteMany({});
    await db.collection('app_settings').deleteOne({ _id: 'change-log-gc' as never });
  });

  describe('findRetentionCutoffCursor', () => {
    it('returns null on empty collection', async () => {
      const coll = await assetChangesCollection();
      const cutoff = new Date();
      const result = await findRetentionCutoffCursor(coll, cutoff);
      expect(result).toBeNull();
    });

    it('returns null when all rows are newer than cutoff', async () => {
      const coll = await assetChangesCollection();
      const now = Date.now();
      await coll.insertMany([
        {
          _id: new ObjectId(),
          cursor: 1,
          asset_id: new ObjectId(),
          folder_id: new ObjectId(),
          kind: 'create',
          abs_path: '/p/1.dng',
          relative_path: '1.dng',
          at: new Date(now - 5 * DAY_MS),
        },
        {
          _id: new ObjectId(),
          cursor: 2,
          asset_id: new ObjectId(),
          folder_id: new ObjectId(),
          kind: 'update',
          abs_path: '/p/2.dng',
          relative_path: '2.dng',
          at: new Date(now - 2 * DAY_MS),
        },
      ]);
      const cutoff = new Date(now - 10 * DAY_MS); // 10 days ago is before all rows
      const result = await findRetentionCutoffCursor(coll, cutoff);
      expect(result).toBeNull();
    });

    it('returns highest cursor when all rows are older than cutoff', async () => {
      const coll = await assetChangesCollection();
      const now = Date.now();
      await coll.insertMany([
        {
          _id: new ObjectId(),
          cursor: 1,
          asset_id: new ObjectId(),
          folder_id: new ObjectId(),
          kind: 'create',
          abs_path: '/p/1.dng',
          relative_path: '1.dng',
          at: new Date(now - 40 * DAY_MS),
        },
        {
          _id: new ObjectId(),
          cursor: 2,
          asset_id: new ObjectId(),
          folder_id: new ObjectId(),
          kind: 'update',
          abs_path: '/p/2.dng',
          relative_path: '2.dng',
          at: new Date(now - 35 * DAY_MS),
        },
      ]);
      const cutoff = new Date(now - 30 * DAY_MS);
      const result = await findRetentionCutoffCursor(coll, cutoff);
      expect(result).toBe(2);
    });

    it('finds boundary cursor using binary search across mixed rows', async () => {
      const coll = await assetChangesCollection();
      const now = Date.now();
      const docs: AssetChangeDoc[] = [];
      // 10 docs: 1..5 are older than 30 days, 6..10 are newer
      for (let i = 1; i <= 10; i++) {
        docs.push({
          cursor: i,
          asset_id: new ObjectId(),
          folder_id: new ObjectId(),
          kind: 'update',
          abs_path: `/p/${i}.dng`,
          relative_path: `${i}.dng`,
          at: new Date(now - (40 - i * 2) * DAY_MS), // i=1: -38d, i=5: -30d (older than cutoff), i=6: -28d (newer)
        });
      }
      await coll.insertMany(docs);
      const cutoff = new Date(now - 29 * DAY_MS);
      const result = await findRetentionCutoffCursor(coll, cutoff);
      expect(result).toBe(5);
    });
  });

  describe('runChangeLogGcOnce', () => {
    it('deletes rows older than cutoff and retains newer rows in bounded batches', async () => {
      const coll = await assetChangesCollection();
      const now = Date.now();
      const docs: AssetChangeDoc[] = [];
      // 6 old rows (cursors 1..6, 40 days old)
      for (let i = 1; i <= 6; i++) {
        docs.push({
          cursor: i,
          asset_id: new ObjectId(),
          folder_id: new ObjectId(),
          kind: 'update',
          abs_path: `/p/${i}.dng`,
          relative_path: `${i}.dng`,
          at: new Date(now - 40 * DAY_MS),
        });
      }
      // 4 fresh rows (cursors 7..10, 5 days old)
      for (let i = 7; i <= 10; i++) {
        docs.push({
          cursor: i,
          asset_id: new ObjectId(),
          folder_id: new ObjectId(),
          kind: 'update',
          abs_path: `/p/${i}.dng`,
          relative_path: `${i}.dng`,
          at: new Date(now - 5 * DAY_MS),
        });
      }
      await coll.insertMany(docs);

      // Run with batchSize=2, retentionDays=30
      const summary = await runChangeLogGcOnce({ retentionDays: 30, batchSize: 2 });
      expect(summary.deleted).toBe(6);
      expect(summary.batches).toBe(3);
      expect(summary.cutoffCursor).toBe(6);

      // Verify remaining docs in DB
      const remaining = await coll.find({}).sort({ cursor: 1 }).toArray();
      expect(remaining.length).toBe(4);
      expect(remaining.map((r) => r.cursor)).toEqual([7, 8, 9, 10]);
    });

    it('does not modify or rewind server_state cursor sequence', async () => {
      const seqBefore = await allocateCursor();
      expect(seqBefore).toBeGreaterThan(0);

      const coll = await assetChangesCollection();
      await coll.insertOne({
        cursor: seqBefore,
        asset_id: new ObjectId(),
        folder_id: new ObjectId(),
        kind: 'delete',
        abs_path: '/p/old.dng',
        relative_path: 'old.dng',
        at: new Date(Date.now() - 40 * DAY_MS),
      });

      const summary = await runChangeLogGcOnce({ retentionDays: 30 });
      expect(summary.deleted).toBe(1);

      // Server state should NOT be touched
      const stateColl = await serverStateCollection();
      const stateDoc = await stateColl.findOne({ _id: 'asset_changes_cursor' });
      expect(stateDoc?.seq).toBe(seqBefore);

      // Allocating next cursor should proceed monotonically
      const nextSeq = await allocateCursor();
      expect(nextSeq).toBe(seqBefore + 1);
    });

    it('is idempotent on an empty collection or when nothing is expired', async () => {
      const summary1 = await runChangeLogGcOnce({ retentionDays: 30 });
      expect(summary1.deleted).toBe(0);
      expect(summary1.batches).toBe(0);
      expect(summary1.cutoffCursor).toBeNull();

      const coll = await assetChangesCollection();
      await coll.insertOne({
        cursor: 100,
        asset_id: new ObjectId(),
        folder_id: new ObjectId(),
        kind: 'create',
        abs_path: '/p/fresh.dng',
        relative_path: 'fresh.dng',
        at: new Date(),
      });

      const summary2 = await runChangeLogGcOnce({ retentionDays: 30 });
      expect(summary2.deleted).toBe(0);
      expect(await coll.countDocuments()).toBe(1);
    });

    it('stops mid-sweep when shouldStop signals cooperative cancellation', async () => {
      const coll = await assetChangesCollection();
      const now = Date.now();
      const docs: AssetChangeDoc[] = [];
      for (let i = 1; i <= 6; i++) {
        docs.push({
          cursor: i,
          asset_id: new ObjectId(),
          folder_id: new ObjectId(),
          kind: 'update',
          abs_path: `/p/${i}.dng`,
          relative_path: `${i}.dng`,
          at: new Date(now - 40 * DAY_MS),
        });
      }
      await coll.insertMany(docs);

      // `shouldStop` is polled once before the pass takes its first write, and
      // then once per batch. Let the pass start, let one batch through, cancel
      // at the next poll.
      let polls = 0;
      const summary = await runChangeLogGcOnce({
        retentionDays: 30,
        batchSize: 2,
        shouldStop: () => ++polls > 2,
      });

      expect(summary.batches).toBe(1);
      expect(summary.deleted).toBe(2);
      expect(await coll.countDocuments()).toBe(4);
    });

    it('skips sweep when enabled is false in config', async () => {
      const { saveChangeLogGcConfig } = await import('./change-log-gc-config.repo.ts');
      await saveChangeLogGcConfig({ enabled: false });

      const coll = await assetChangesCollection();
      await coll.insertOne({
        cursor: 1,
        asset_id: new ObjectId(),
        folder_id: new ObjectId(),
        kind: 'update',
        abs_path: '/p/1.dng',
        relative_path: '1.dng',
        at: new Date(Date.now() - 40 * DAY_MS),
      });

      const summary = await runChangeLogGcOnce();
      expect(summary.skipped).toBe(true);
      expect(summary.deleted).toBe(0);
      expect(await coll.countDocuments()).toBe(1);
    });

    it('persists last_run telemetry after pass', async () => {
      const { loadChangeLogGcConfig } = await import('./change-log-gc-config.repo.ts');
      const coll = await assetChangesCollection();
      await coll.insertOne({
        cursor: 1,
        asset_id: new ObjectId(),
        folder_id: new ObjectId(),
        kind: 'update',
        abs_path: '/p/1.dng',
        relative_path: '1.dng',
        at: new Date(Date.now() - 40 * DAY_MS),
      });

      const summary = await runChangeLogGcOnce({ retentionDays: 30 });
      expect(summary.deleted).toBe(1);

      const config = await loadChangeLogGcConfig();
      expect(config.last_run).not.toBeNull();
      expect(config.last_run?.deleted).toBe(1);
      expect(config.last_run?.batches).toBe(1);
      expect(config.last_run?.pruned_through).toBe(1);
    });

    // The floor is what the poll route answers "cursor too old" from. It has to
    // be in place before the deletes, and it has to survive a pass that is
    // cancelled partway — otherwise a client anchored in the range this sweep
    // half-deleted is told everything is fine.
    it('raises the retention floor to the cutoff, before it starts deleting', async () => {
      const coll = await assetChangesCollection();
      const now = Date.now();
      await coll.insertMany(
        Array.from({ length: 6 }, (_, idx) => ({
          cursor: idx + 1,
          asset_id: new ObjectId(),
          folder_id: new ObjectId(),
          kind: 'update' as const,
          abs_path: `/p/${idx + 1}.dng`,
          relative_path: `${idx + 1}.dng`,
          at: new Date(now - 40 * DAY_MS),
        })),
      );

      const summary = await runChangeLogGcOnce({ retentionDays: 30, batchSize: 2 });

      expect(summary.cutoffCursor).toBe(6);
      expect(await changeLogPruneFloor()).toBe(6);
    });

    it('keeps the floor raised when a pass is cancelled halfway through', async () => {
      const coll = await assetChangesCollection();
      const now = Date.now();
      await coll.insertMany(
        Array.from({ length: 6 }, (_, idx) => ({
          cursor: idx + 1,
          asset_id: new ObjectId(),
          folder_id: new ObjectId(),
          kind: 'update' as const,
          abs_path: `/p/${idx + 1}.dng`,
          relative_path: `${idx + 1}.dng`,
          at: new Date(now - 40 * DAY_MS),
        })),
      );

      let polls = 0;
      await runChangeLogGcOnce({
        retentionDays: 30,
        batchSize: 2,
        shouldStop: () => ++polls > 2,
      });

      expect(await coll.countDocuments()).toBe(4);
      expect(await changeLogPruneFloor()).toBe(6);
    });

    it('never lowers the floor on a later, smaller pass', async () => {
      const coll = await assetChangesCollection();
      const now = Date.now();
      await coll.insertMany([
        {
          cursor: 500,
          asset_id: new ObjectId(),
          folder_id: new ObjectId(),
          kind: 'update' as const,
          abs_path: '/p/500.dng',
          relative_path: '500.dng',
          at: new Date(now - 40 * DAY_MS),
        },
      ]);
      await runChangeLogGcOnce({ retentionDays: 30 });
      expect(await changeLogPruneFloor()).toBe(500);

      await coll.insertOne({
        cursor: 10,
        asset_id: new ObjectId(),
        folder_id: new ObjectId(),
        kind: 'update',
        abs_path: '/p/10.dng',
        relative_path: '10.dng',
        at: new Date(now - 40 * DAY_MS),
      });
      await runChangeLogGcOnce({ retentionDays: 30 });
      expect(await changeLogPruneFloor()).toBe(500);
    });

    // A row with no usable `at` cannot be dated, and retention must not guess.
    // `undefined < Date` is false in JS, so the old comparison happened to keep
    // it — this pins the behaviour so a refactor can't quietly invert it.
    it('will not prune a row whose timestamp is unusable', async () => {
      const coll = await assetChangesCollection();
      await coll.insertMany([
        {
          cursor: 1,
          asset_id: new ObjectId(),
          folder_id: new ObjectId(),
          kind: 'update' as const,
          abs_path: '/p/1.dng',
          relative_path: '1.dng',
          at: undefined as unknown as Date,
        },
        {
          cursor: 2,
          asset_id: new ObjectId(),
          folder_id: new ObjectId(),
          kind: 'update' as const,
          abs_path: '/p/2.dng',
          relative_path: '2.dng',
          at: new Date(Date.now() - 40 * DAY_MS),
        },
      ]);

      const summary = await runChangeLogGcOnce({ retentionDays: 30 });
      expect(summary.deleted).toBe(0);
      expect(summary.cutoffCursor).toBeNull();
      expect(await coll.countDocuments()).toBe(2);
      expect(await changeLogPruneFloor()).toBe(0);
    });

    // Deleting is irreversible, so "couldn't read the operator's setting" has
    // to mean "don't run", not "run on the 30-day default".
    it('skips the pass when the config cannot be read', async () => {
      const unreadable = {
        collection: () => ({
          findOne: () => Promise.reject(new Error('connection timed out')),
        }),
      } as unknown as Db;

      const summary = await runChangeLogGcOnce({ dbOverride: unreadable });
      expect(summary.skipped).toBe(true);
      expect(summary.deleted).toBe(0);
    });
  });

  describe('startChangeLogGc', () => {
    it('returns a handle that stops the interval, leaving the startup pass a no-op', async () => {
      const coll = await assetChangesCollection();
      await coll.insertOne({
        cursor: 1,
        asset_id: new ObjectId(),
        folder_id: new ObjectId(),
        kind: 'update',
        abs_path: '/p/1.dng',
        relative_path: '1.dng',
        at: new Date(Date.now() - 40 * DAY_MS),
      });

      const handle = startChangeLogGc({ intervalMs: 10_000 });
      expect(typeof handle.stop).toBe('function');
      handle.stop();

      // The worker fires one pass on startup, so `stop()` lands mid-await. Let
      // it settle here — both to prove it wrote nothing, and so its `getDb()`
      // resolves against this suite's scoped database instead of leaking a
      // connection to the default one once the env override is restored.
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(await coll.countDocuments()).toBe(1);
      expect(await changeLogPruneFloor()).toBe(0);
    });
  });
});
