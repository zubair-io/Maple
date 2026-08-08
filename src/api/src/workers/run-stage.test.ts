import { describe, expect, it } from 'bun:test';
import { ObjectId } from 'mongodb';
import {
  _test,
  buildClaimQuery,
  defineStage,
  deriveBatchSize,
  type ImageDoc,
  type StageState,
} from './run-stage.ts';
import { makeConfigMock, makeImagesMock } from './run-stage.test-helpers.ts';

const { bootConfig, versionBumpReset } = _test;

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

const baseStage = defineStage({
  name: 'hash',
  targetVersion: 2,
  dependsOn: [],
  defaults: {
    concurrency: 4,
    maxAttempts: 5,
    paused: false,
    pausedOnFirstBoot: false,
    last_seen_target_version: 0,
  },
  handler: async (_image, _ctx) => ({ patch: {} }),
});

describe('bootConfig', () => {
  it('seeds worker_config from defaults on first boot', async () => {
    const coll = makeConfigMock();
    const cfg = await bootConfig(baseStage, coll);
    expect(cfg.concurrency).toBe(4);
    expect(cfg.paused).toBe(false);
    const { WorkerConfigRepo } = await import('./worker-config.repo.ts');
    const repo = new WorkerConfigRepo(coll);
    const loaded = await repo.load(baseStage.name);
    expect(loaded?.last_seen_target_version).toBe(0);
  });

  it('respects pausedOnFirstBoot for paused stages', async () => {
    const coll = makeConfigMock();
    const pausedStage = defineStage({
      ...baseStage,
      name: 'describe',
      defaults: { ...baseStage.defaults, pausedOnFirstBoot: true },
    });
    const cfg = await bootConfig(pausedStage, coll);
    expect(cfg.paused).toBe(true);
  });

  it('returns existing config without overwriting on re-boot', async () => {
    const coll = makeConfigMock();
    await (coll as unknown as { updateOne: Function }).updateOne(
      { name: 'hash' },
      {
        $set: {
          name: 'hash',
          concurrency: 8,
          maxAttempts: 5,
          paused: true,
          last_seen_target_version: 1,
        },
      },
      { upsert: true },
    );
    const cfg = await bootConfig(baseStage, coll);
    expect(cfg.concurrency).toBe(8);
    expect(cfg.paused).toBe(true);
  });

  it('backfills missing integer fields from defaults on partial docs', async () => {
    // Reproduces the production bug: a PATCH /api/workers/face/config landing
    // before the child's first bootConfig writes a doc with $setOnInsert
    // limited to `name`. The doc is missing the integer fields the poll
    // loop needs. Without the merge, the next limit() call throws
    // `Operation "limit" requires an integer` on every tick.
    const coll = makeConfigMock();
    await (coll as unknown as { updateOne: Function }).updateOne(
      { name: 'hash' },
      { $set: { paused: false }, $setOnInsert: { name: 'hash' } },
      { upsert: true },
    );

    const cfg = await bootConfig(baseStage, coll);

    expect(Number.isInteger(cfg.concurrency)).toBe(true);
    expect(Number.isInteger(cfg.maxAttempts)).toBe(true);
    expect(Number.isInteger(cfg.last_seen_target_version)).toBe(true);
    expect(cfg.concurrency).toBe(baseStage.defaults.concurrency);
    expect(cfg.paused).toBe(false);
  });
});

describe('versionBumpReset', () => {
  it('resets dead docs when targetVersion > last_seen_target_version', async () => {
    const deadState: StageState = {
      version: 1,
      attempts: 5,
      last_error: 'network error',
      processed_at: null,
      dead: true,
    };
    const doneState: StageState = {
      version: 2,
      attempts: 0,
      last_error: null,
      processed_at: new Date(),
      dead: false,
    };
    const images = makeImagesMock([
      {
        abs_path: '/a.raw',
        stages: { hash: deadState },
      } as unknown as ImageDoc,
      {
        abs_path: '/b.raw',
        stages: { hash: deadState },
      } as unknown as ImageDoc,
      {
        abs_path: '/c.raw',
        stages: { hash: doneState },
      } as unknown as ImageDoc,
    ]);

    await versionBumpReset(baseStage, 1, images);

    const docs = await images.find({}).toArray();
    const a = docs.find((d) => (d as unknown as { abs_path: string }).abs_path === '/a.raw')!;
    const c = docs.find((d) => (d as unknown as { abs_path: string }).abs_path === '/c.raw')!;

    expect(a.stages?.hash?.dead).toBe(false);
    expect(a.stages?.hash?.attempts).toBe(0);
    expect(a.stages?.hash?.last_error).toBeNull();
    expect(c.stages?.hash?.version).toBe(2);
  });

  it('does nothing when versions match', async () => {
    const images = makeImagesMock([
      {
        abs_path: '/a.raw',
        stages: {
          hash: {
            version: 1,
            attempts: 5,
            last_error: 'x',
            processed_at: null,
            dead: true,
          },
        },
      } as unknown as ImageDoc,
    ]);

    await versionBumpReset(baseStage, 2, images);

    const docs = await images.find({}).toArray();
    expect(docs[0]?.stages?.hash?.dead).toBe(true);
  });
});

describe('buildClaimQuery', () => {
  it('uses $or to match version < targetVersion or missing field', () => {
    const q = buildClaimQuery('hash', 2, [], new Set());
    const orClauses = (q as Record<string, unknown>)['$or'] as Record<string, unknown>[];
    expect(orClauses).toHaveLength(2);
    expect(orClauses[0]).toEqual({ 'stages.hash.version': { $lt: 2 } });
    expect(orClauses[1]).toEqual({ 'stages.hash.version': { $exists: false } });
    expect(q['stages.hash.dead']).toEqual({ $ne: true });
  });

  it('parks no-live-location + damaged assets out of every claim query', () => {
    const q = buildClaimQuery('hash', 2, [], new Set()) as Record<string, unknown>;
    // Claimable requires >=1 LIVE fileinfo entry; damaged stays excluded.
    expect(q['fileinfo']).toEqual({
      $elemMatch: { deleted_at: { $in: [null] }, missing_since: { $in: [null] } },
    });
    expect(q['damaged.since']).toEqual({ $not: { $type: 'string' } });
  });

  it('adds dependency version predicates using dep.minVersion', () => {
    const q = buildClaimQuery('exif', 1, [{ name: 'hash', minVersion: 1 }], new Set());
    expect((q as Record<string, unknown>)['stages.hash.version']).toEqual({
      $gte: 1,
    });
  });

  it('excludes in-flight _ids', () => {
    const id1 = 'id1' as unknown as ObjectId;
    const id2 = 'id2' as unknown as ObjectId;
    const inFlight = new Set([id1, id2]);
    const q = buildClaimQuery(
      'thumb',
      1,
      [
        { name: 'hash', minVersion: 1 },
        { name: 'exif', minVersion: 1 },
      ],
      inFlight,
    );
    expect((q['_id'] as { $nin: unknown[] }).$nin).toHaveLength(2);
  });

  it('omits _id.$nin when in-flight is empty', () => {
    const q = buildClaimQuery('hash', 1, [], new Set());
    expect(q['_id']).toBeUndefined();
  });

  it('matches docs without a stages field (missing-field branch)', async () => {
    const images = makeImagesMock([{ abs_path: '/no-stages.raw' } as unknown as ImageDoc]);
    const q = buildClaimQuery('hash', 1, [], new Set());
    const docs = await images
      .find(q as Record<string, unknown>)
      .limit(10)
      .toArray();
    expect(docs).toHaveLength(1);
    expect((docs[0] as unknown as { abs_path?: string } | undefined)?.abs_path).toBe(
      '/no-stages.raw',
    );
  });

  it('respects dep minVersion when greater than 1', async () => {
    const images = makeImagesMock([
      {
        abs_path: '/dep-stale.raw',
        stages: {
          hash: {
            version: 1,
            attempts: 0,
            last_error: null,
            processed_at: null,
            dead: false,
          },
        },
      } as unknown as ImageDoc,
      {
        abs_path: '/dep-ready.raw',
        stages: {
          hash: {
            version: 2,
            attempts: 0,
            last_error: null,
            processed_at: null,
            dead: false,
          },
        },
      } as unknown as ImageDoc,
    ]);
    const q = buildClaimQuery('exif', 1, [{ name: 'hash', minVersion: 2 }], new Set());
    const docs = await images
      .find(q as Record<string, unknown>)
      .limit(10)
      .toArray();
    expect(docs).toHaveLength(1);
    expect((docs[0] as unknown as { abs_path?: string } | undefined)?.abs_path).toBe(
      '/dep-ready.raw',
    );
  });
});

describe('defineStage', () => {
  it('returns the config object unchanged', () => {
    const cfg = defineStage({
      name: 'test',
      targetVersion: 1,
      dependsOn: [],
      defaults: {
        concurrency: 2,
        maxAttempts: 3,
        paused: false,
        pausedOnFirstBoot: false,
        last_seen_target_version: 0,
      },
      handler: async (_image, _ctx) => ({ patch: { test: true } }),
    });
    expect(cfg.name).toBe('test');
    expect(cfg.targetVersion).toBe(1);
    expect(cfg.dependsOn).toEqual([]);
    expect(cfg.defaults.concurrency).toBe(2);
  });
});
