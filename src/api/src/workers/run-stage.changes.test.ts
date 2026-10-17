import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { createLiveTestDatabase } from '../db/sqlite/test-sqlite.test-helpers.ts';
import { seedClaimableAssets, stageRow } from '../db/repos/stage-runtime.test-helpers.ts';
import { listChangesSince } from '../db/changes.repo.ts';
import { __resetChangeBusForTests, getChangeBus } from '../runtime/change-bus.ts';
import { defineStage, runOnce } from './run-stage.ts';
import type { SqlStatement } from '../db/sqlite/protocol.ts';

const config = { concurrency: 1, maxAttempts: 3, paused: false, last_seen_target_version: 1 };
const base = {
  name: 'hash',
  targetVersion: 1,
  dependsOn: [],
  defaults: { ...config, pausedOnFirstBoot: false },
};
beforeEach(__resetChangeBusForTests);
afterEach(__resetChangeBusForTests);

describe('stage change publication', () => {
  test('keeps the journal empty until writeback and exposes the patch at SSE delivery', async () => {
    using live = await createLiveTestDatabase();
    seedClaimableAssets(live.db, 'hash', 2);
    const betweenHandlers: number[] = [];
    const delivered: unknown[] = [];
    const versions: (number | undefined)[] = [];
    const unsubscribe = getChangeBus().subscribe((event) => {
      versions.push(stageRow(live.db, event.asset_id!.toHexString(), 'hash')?.version);
      delivered.push(
        live.db.query('SELECT rating FROM assets WHERE id = ?').get(event.asset_id!.toHexString()),
      );
    });
    try {
      const stage = defineStage({
        ...base,
        handler: async (doc) => {
          betweenHandlers.push((await listChangesSince(undefined, { since: 0, limit: 10 })).length);
          return {
            patch: [
              { sql: 'UPDATE assets SET rating = 3 WHERE id = ?', params: [doc._id.toHexString()] },
            ],
          };
        },
      });
      await runOnce(stage, config);
      expect(betweenHandlers).toEqual([0, 0]);
      expect(delivered).toEqual([{ rating: 3 }, { rating: 3 }]);
      expect(versions).toEqual([1, 1]);
      expect(await listChangesSince(undefined, { since: 0, limit: 10 })).toHaveLength(2);
    } finally {
      unsubscribe();
    }
  });

  test('publishes wrote results only after their stage state commits', async () => {
    using live = await createLiveTestDatabase();
    const [assetId] = seedClaimableAssets(live.db, 'hash', 1);
    const versions: (number | undefined)[] = [];
    const unsubscribe = getChangeBus().subscribe(() => {
      versions.push(stageRow(live.db, assetId!, 'hash')?.version);
    });
    try {
      await runOnce(defineStage({ ...base, handler: async () => ({ wrote: true }) }), config);
      expect(versions).toEqual([1]);
      expect(await listChangesSince(undefined, { since: 0, limit: 10 })).toHaveLength(1);
    } finally {
      unsubscribe();
    }
  });

  for (const oversized of [false, true]) {
    test(`does not publish dropped writebacks (${oversized ? 'threshold' : 'final'} flush)`, async () => {
      using live = await createLiveTestDatabase();
      seedClaimableAssets(live.db, 'hash', 2);
      const handled: string[] = [];
      const delivered: string[] = [];
      const unsubscribe = getChangeBus().subscribe((event) =>
        delivered.push(event.asset_id!.toHexString()),
      );
      try {
        const stage = defineStage({
          ...base,
          handler: async (doc) => {
            const id = doc._id.toHexString();
            handled.push(id);
            const patch: SqlStatement[] = [
              { sql: 'UPDATE assets SET rating = 4 WHERE id = ?', params: [id] },
            ];
            if (handled.length === 1) {
              // Fail a real SQLite foreign-key constraint, including after the
              // batch retries this result by itself.
              patch.push({
                sql: 'INSERT INTO asset_detail (asset_id, description) VALUES (?, ?)',
                params: ['absent-asset', 'orphan'],
              });
              if (oversized)
                patch.push(...Array.from({ length: 256 }, () => ({ sql: 'SELECT 1' })));
            }
            return { patch };
          },
        });
        await runOnce(stage, config);
        const changes = await listChangesSince(undefined, { since: 0, limit: 10 });
        expect(changes.map((event) => event.asset_id!.toHexString())).toEqual([handled[1]!]);
        expect(delivered).toEqual([handled[1]!]);
        expect(live.db.query('SELECT rating FROM assets WHERE id = ?').get(handled[0]!)).toEqual({
          rating: 0,
        });
        expect(live.db.query('SELECT rating FROM assets WHERE id = ?').get(handled[1]!)).toEqual({
          rating: 4,
        });
      } finally {
        unsubscribe();
      }
    });
  }
});
