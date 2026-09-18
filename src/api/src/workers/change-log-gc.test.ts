import { describe, expect, it, beforeEach } from 'bun:test';
import { ObjectId } from 'mongodb';
import { getDb, assetChangesCollection, serverStateCollection } from '../db/client.ts';
import type { AssetChangeDoc } from '../db/schema.ts';
import {
  findRetentionCutoffCursor,
  runChangeLogGcOnce,
  startChangeLogGc,
} from './change-log-gc.ts';
import { allocateCursor } from '../db/changes.repo.ts';

const DAY_MS = 86_400_000;

describe('change-log-gc', () => {
  beforeEach(async () => {
    try {
      const db = await getDb();
      await db.collection('asset_changes').deleteMany({});
      await db.collection('app_settings').deleteOne({ _id: 'change-log-gc' });
    } catch {
      // Ignore if DB unreachable
    }
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
  });

  describe('startChangeLogGc', () => {
    it('returns a handle that stops the interval', () => {
      const handle = startChangeLogGc({ intervalMs: 10_000 });
      expect(handle).toBeDefined();
      expect(typeof handle.stop).toBe('function');
      handle.stop();
    });
  });
});
