import { afterEach, describe, expect, it } from 'bun:test';
import { join } from 'node:path';
import {
  createTempLibrary,
  testSqliteDb,
  insertAsset,
} from '../../db/sqlite/test-sqlite.test-helpers.ts';
import { stageFailureStatements } from '../../db/repos/stage-writeback.ts';
import { ObjectId } from '../../db/object-id.ts';
import { DescribeServerPool } from '../../enrichment/describe-server-pool.ts';
import {
  BilledOutputError,
  RemoteError,
  TruncatedOutputError,
} from '../../enrichment/describe-providers/index.ts';
import { setLibraryRootsForTests } from '../../indexer/libraries.cache.ts';
import { describeHandler, setDescribeDepsForTests } from './describe.ts';
import { videoDescribeHandler, setVideoDescribeDepsForTests } from './video-describe.ts';
import { fakeDoc, stageDocIn, VALID_VISION } from './describe.fixtures.ts';

afterEach(() => {
  setDescribeDepsForTests(null);
  setVideoDescribeDepsForTests(null);
  setLibraryRootsForTests(null);
});

describe.each(['describe', 'video-describe'] as const)('%s failed-call billing', (stage) => {
  it.each(['truncated', 'transport', 'terminal', 'parse', 'empty'] as const)(
    'persists aggregate costs after %s failure and retains them after recovery',
    async (scenario) => {
      using library = await createTempLibrary('maple-describe-cost-');
      const live = { db: library.db, handle: testSqliteDb(library.db) };
      const root = library.root;
      const libraryId = new ObjectId(library.folderId);
      setLibraryRootsForTests(new Map([[libraryId.toHexString(), root]]));
      const video = stage === 'video-describe';
      const path = join(root, video ? 'clip.mp4' : 'photo.dng');
      const doc = video ? fakeDoc(path, libraryId, root) : await stageDocIn(path, libraryId, root);
      const assetId = insertAsset(live.db, { id: doc._id.toHexString() });
      live.db.run(
        'INSERT INTO stage_state (asset_id, stage, version, attempts, claim_token) VALUES (?, ?, 0, 1, ?)',
        [assetId, stage, 'lease'],
      );
      const frames = [0, 1, 2].map((timestampSec) => ({
        timestampSec,
        jpeg: Buffer.from('frame'),
      }));
      const validText = video
        ? JSON.stringify({
            summary: 'A clip.',
            scenes: [{ frame_index: 0, caption: 'A scene.', text_visible: null }],
          })
        : JSON.stringify(VALID_VISION);
      let recovering = false;
      const pool = new DescribeServerPool(
        [
          { url: 'a', concurrency: 1 },
          { url: 'b', concurrency: 1 },
        ],
        (url) => ({
          name: 'openai',
          health: async () => {},
          describe: async () => {
            if (recovering) return { text: validText, cost_usd: 0.001, provider_info: {} };
            if (url === 'a') throw new TruncatedOutputError('cut off', 0.004);
            if (scenario === 'truncated') throw new TruncatedOutputError('cut off', 0.002);
            if (scenario === 'transport') throw new RemoteError('unavailable', true, 503);
            if (scenario === 'empty') throw new BilledOutputError('empty content', 0.002);
            if (scenario === 'terminal') throw new RemoteError('rejected', false, 400);
            return { text: '{invalid', cost_usd: 0.001, provider_info: {} };
          },
        }),
      );
      const deps = { pool, model: 'm', systemPrompt: 'prompt' };
      setDescribeDepsForTests(deps);
      setVideoDescribeDepsForTests({
        ...deps,
        sampleFrames: async () => ({
          ok: true,
          frames,
          candidateCount: 3,
          samplingMs: 0,
        }),
      });
      const handler = video ? videoDescribeHandler : describeHandler;
      const column = video ? 'video_description_meta' : 'description_meta';
      const readCost = () => {
        const row = live.db
          .query(`SELECT ${column} AS meta FROM asset_detail WHERE asset_id = ?`)
          .get(assetId) as { meta: string } | null;
        return row ? (JSON.parse(row.meta).cost_usd as number) : 0;
      };
      const perAttempt =
        scenario === 'parse'
          ? 0.005
          : scenario === 'truncated' || scenario === 'empty'
            ? 0.006 * (video ? 3 : 1)
            : 0.004 * (video && scenario === 'terminal' ? 3 : 1);
      for (const attemptNo of [1, 2]) {
        live.db.run(
          'UPDATE stage_state SET dead = 0, attempts = ?, claim_token = ?, next_attempt_at = ? WHERE asset_id = ? AND stage = ?',
          [attemptNo, 'lease', '2099-01-01T00:00:00.000Z', assetId, stage],
        );
        const err = await handler(doc, {} as never).catch((error: unknown) => error);
        expect(err).toBeInstanceOf(Error);
        expect((err as { cost_usd: number }).cost_usd).toBeCloseTo(perAttempt, 10);
        const failure = stageFailureStatements({
          target: { assetId, stage, targetVersion: 9, lease: 'lease' },
          attemptNo,
          maxAttempts: 5,
          err,
          retryDelayMs: () => 1000,
        });
        expect(failure.terminal).toBe(scenario !== 'transport' && scenario !== 'parse');
        await live.handle.transaction(failure.statements);
        expect(readCost()).toBeCloseTo(perAttempt * attemptNo, 10);
        const row = live.db
          .query('SELECT dead, last_error FROM stage_state WHERE asset_id = ? AND stage = ?')
          .get(assetId, stage);
        expect(row).toMatchObject({
          dead: failure.dead ? 1 : 0,
          last_error: (err as Error).message,
        });
      }
      const state = live.db
        .query('SELECT version, processed_at FROM stage_state WHERE asset_id = ? AND stage = ?')
        .get(assetId, stage);
      expect(state).toEqual({ version: 0, processed_at: null });
      const detail = live.db
        .query('SELECT description, video_description, vision FROM asset_detail WHERE asset_id = ?')
        .get(assetId);
      expect(detail).toEqual({ description: null, video_description: null, vision: null });
      recovering = true;
      const result = await handler(doc, {} as never);
      if (!('patch' in result)) throw new Error('expected successful description');
      await live.handle.transaction(result.patch);
      expect(readCost()).toBeCloseTo(perAttempt * 2 + 0.001, 10);
    },
  );
});
