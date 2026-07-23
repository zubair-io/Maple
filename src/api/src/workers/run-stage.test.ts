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

describe('poll loop integration', () => {
  it('claims eligible docs and dispatches them', async () => {
    const images = makeImagesMock([
      { abs_path: '/img1.raw' } as unknown as ImageDoc,
      { abs_path: '/img2.raw' } as unknown as ImageDoc,
    ]);
    const configColl = makeConfigMock();

    const processed: string[] = [];
    const testStage = defineStage({
      name: 'hash',
      targetVersion: 1,
      dependsOn: [],
      defaults: {
        concurrency: 2,
        maxAttempts: 3,
        paused: false,
        pausedOnFirstBoot: false,
        last_seen_target_version: 0,
      },
      handler: async (image, _ctx) => {
        processed.push((image as unknown as { abs_path: string }).abs_path);
        return { patch: { sha1_head: 'abc' } };
      },
    });

    const { runOnce } = _test;
    await runOnce(
      testStage,
      {
        concurrency: 2,
        maxAttempts: 3,
        paused: false,
        last_seen_target_version: 1,
      },
      images,
      configColl,
    );

    expect(processed).toHaveLength(2);
    const docs = await images.find({}).toArray();
    const img = docs.find((d) => (d as unknown as { abs_path: string }).abs_path === '/img1.raw')!;
    expect(img?.stages?.hash?.version).toBe(1);
    expect(img?.stages?.hash?.dead).toBe(false);
  });

  it('increments attempts and sets dead after maxAttempts throws', async () => {
    const images = makeImagesMock([{ abs_path: '/bad.raw' } as unknown as ImageDoc]);
    const configColl = makeConfigMock();

    const testStage = defineStage({
      name: 'hash',
      targetVersion: 1,
      dependsOn: [],
      defaults: {
        concurrency: 1,
        maxAttempts: 3,
        paused: false,
        pausedOnFirstBoot: false,
        last_seen_target_version: 0,
      },
      handler: async (_image, _ctx) => {
        throw new Error('always fail');
      },
    });

    const { runOnce } = _test;
    const cfg = {
      concurrency: 1,
      maxAttempts: 3,
      paused: false,
      last_seen_target_version: 1,
    };
    await runOnce(testStage, cfg, images, configColl);
    await runOnce(testStage, cfg, images, configColl);
    await runOnce(testStage, cfg, images, configColl);

    const docs = await images.find({}).toArray();
    const doc = docs.find((d) => (d as unknown as { abs_path: string }).abs_path === '/bad.raw')!;
    expect(doc?.stages?.hash?.attempts).toBe(3);
    expect(doc?.stages?.hash?.dead).toBe(true);
    expect(doc?.stages?.hash?.last_error).toBe('always fail');
  });

  it('tags `damaged` when a tagsDamagedOnDeadLetter stage exhausts retries', async () => {
    const id = new ObjectId();
    const images = makeImagesMock([{ _id: id, abs_path: '/corrupt.cr2' } as unknown as ImageDoc]);
    const configColl = makeConfigMock();

    const testStage = defineStage({
      name: 'exif',
      targetVersion: 1,
      dependsOn: [],
      // The opt-in under test: a file-reading stage that maps "out of retries"
      // to "the bytes are unreadable → tag the whole asset damaged".
      tagsDamagedOnDeadLetter: true,
      defaults: {
        concurrency: 1,
        maxAttempts: 2,
        paused: false,
        pausedOnFirstBoot: false,
        last_seen_target_version: 0,
      },
      handler: async () => {
        throw new Error('Unknown file format');
      },
    });

    const { runOnce } = _test;
    const cfg = {
      concurrency: 1,
      maxAttempts: 2,
      paused: false,
      last_seen_target_version: 1,
    };
    // First failure: attempts 1 < 2 → not dead yet, so no damaged tag.
    await runOnce(testStage, cfg, images, configColl);
    let doc = (await images.find({}).toArray())[0] as unknown as ImageDoc;
    expect(doc.stages?.exif?.dead).toBe(false);
    expect(doc.damaged ?? null).toBeNull();

    // Second failure crosses maxAttempts → dead → damaged tag stamped.
    await runOnce(testStage, cfg, images, configColl);
    doc = (await images.find({}).toArray())[0] as unknown as ImageDoc;
    expect(doc.stages?.exif?.dead).toBe(true);
    expect(doc.damaged?.stage).toBe('exif');
    expect(doc.damaged?.reason).toBe('Unknown file format');
    expect(typeof doc.damaged?.since).toBe('string');
  });

  it('tags `damaged` immediately when a handler returns { damaged } (no retries)', async () => {
    const id = new ObjectId();
    const images = makeImagesMock([{ _id: id, abs_path: '/empty.dng' } as unknown as ImageDoc]);
    const configColl = makeConfigMock();

    const testStage = defineStage({
      name: 'exif',
      targetVersion: 1,
      dependsOn: [],
      tagsDamagedOnDeadLetter: true,
      defaults: {
        concurrency: 1,
        maxAttempts: 5,
        paused: false,
        pausedOnFirstBoot: false,
        last_seen_target_version: 0,
      },
      // Deterministically-unreadable: report it instead of throwing 5x.
      handler: async () => ({ damaged: 'file is empty (0 bytes)' }),
    });

    const cfg = { concurrency: 1, maxAttempts: 5, paused: false, last_seen_target_version: 1 };
    // ONE tick is enough — no waiting for maxAttempts.
    await _test.runOnce(testStage, cfg, images, configColl);
    const doc = (await images.find({}).toArray())[0] as unknown as ImageDoc;
    expect(doc.stages?.exif?.dead).toBe(true);
    // Honest bookkeeping: one attempt that classified the file, NOT maxAttempts
    // — this path never retried, so it must not look exhausted.
    expect(doc.stages?.exif?.attempts).toBe(1);
    expect(doc.damaged?.stage).toBe('exif');
    expect(doc.damaged?.reason).toBe('file is empty (0 bytes)');
    expect(typeof doc.damaged?.since).toBe('string');
  });

  it('rejects a { damaged } result from a stage without tagsDamagedOnDeadLetter', async () => {
    const id = new ObjectId();
    const images = makeImagesMock([{ _id: id, abs_path: '/x.jpg' } as unknown as ImageDoc]);
    const configColl = makeConfigMock();

    const testStage = defineStage({
      name: 'meili', // not a damage-tagging stage
      targetVersion: 1,
      dependsOn: [],
      defaults: {
        concurrency: 1,
        maxAttempts: 2,
        paused: false,
        pausedOnFirstBoot: false,
        last_seen_target_version: 0,
      },
      handler: async () => ({ damaged: 'should not be honored' }),
    });

    const cfg = { concurrency: 1, maxAttempts: 2, paused: false, last_seen_target_version: 1 };
    // The runner throws inside the work unit (caught → counts as a failed
    // attempt); the asset is never tagged damaged by a non-damage-tagging stage.
    await _test.runOnce(testStage, cfg, images, configColl);
    const doc = (await images.find({}).toArray())[0] as unknown as ImageDoc;
    expect(doc.damaged ?? null).toBeNull();
    expect(doc.stages?.meili?.last_error).toMatch(/not a damage-tagging stage/);
  });

  it('does NOT tag `damaged` when the stage lacks tagsDamagedOnDeadLetter', async () => {
    const id = new ObjectId();
    const images = makeImagesMock([{ _id: id, abs_path: '/slow.jpg' } as unknown as ImageDoc]);
    const configColl = makeConfigMock();

    const testStage = defineStage({
      name: 'describe',
      targetVersion: 1,
      dependsOn: [],
      // No tagsDamagedOnDeadLetter — a describe/geocode dead-letter must not
      // imply the file itself is damaged.
      defaults: {
        concurrency: 1,
        maxAttempts: 1,
        paused: false,
        pausedOnFirstBoot: false,
        last_seen_target_version: 0,
      },
      handler: async () => {
        throw new Error('LLM timeout');
      },
    });

    const { runOnce } = _test;
    await runOnce(
      testStage,
      {
        concurrency: 1,
        maxAttempts: 1,
        paused: false,
        last_seen_target_version: 1,
      },
      images,
      configColl,
    );
    const doc = (await images.find({}).toArray())[0] as unknown as ImageDoc;
    expect(doc.stages?.describe?.dead).toBe(true);
    expect(doc.damaged ?? null).toBeNull();
  });

  it('skips the find when paused', async () => {
    const images = makeImagesMock([{ abs_path: '/img.raw' } as unknown as ImageDoc]);
    const configColl = makeConfigMock();
    let called = false;

    const testStage = defineStage({
      name: 'hash',
      targetVersion: 1,
      dependsOn: [],
      defaults: {
        concurrency: 1,
        maxAttempts: 3,
        paused: false,
        pausedOnFirstBoot: false,
        last_seen_target_version: 0,
      },
      handler: async () => {
        called = true;
        return { patch: {} };
      },
    });

    const { runOnce } = _test;
    await runOnce(
      testStage,
      {
        concurrency: 1,
        maxAttempts: 3,
        paused: true,
        last_seen_target_version: 1,
      },
      images,
      configColl,
    );

    expect(called).toBe(false);
  });

  it('derives the claim batch size as 5×concurrency at the .limit() site', async () => {
    // 21 eligible docs, concurrency 4 → derived batch = 20. The claim query
    // must pull at most 20 this tick (the 21st waits for the next tick), and
    // the full-batch signal (claimed === 20) flows back through runOnce.
    const docs: ImageDoc[] = Array.from(
      { length: 21 },
      (_unused, i) => ({ abs_path: `/img${i}.raw` }) as unknown as ImageDoc,
    );
    const images = makeImagesMock(docs);
    const configColl = makeConfigMock();

    const testStage = defineStage({
      name: 'hash',
      targetVersion: 1,
      dependsOn: [],
      defaults: {
        concurrency: 4,
        maxAttempts: 3,
        paused: false,
        pausedOnFirstBoot: false,
        last_seen_target_version: 0,
      },
      // `skip` avoids the publishUpdate path (which would hit the DB), keeping
      // this test free of a live Mongo while still exercising the claim limit.
      handler: async (_image) => ({ skip: 'noop' }),
    });

    const { runOnce } = _test;
    const claimed = await runOnce(
      testStage,
      {
        concurrency: 4,
        maxAttempts: 3,
        paused: false,
        last_seen_target_version: 1,
      },
      images,
      configColl,
    );

    expect(deriveBatchSize(4)).toBe(20);
    expect(claimed).toBe(20);
  });

  it("resets the stages listed in a patch result's `invalidates` (#2172)", async () => {
    // A doc whose meili stage already completed — the describe→meili shape:
    // the caption lands AFTER the search index was built, so the patch result
    // asks the runner to mark meili stale in the same atomic write.
    const images = makeImagesMock([
      {
        abs_path: '/img1.raw',
        stages: {
          meili: {
            version: 6,
            attempts: 0,
            last_error: null,
            processed_at: new Date(),
            dead: false,
          },
        },
      } as unknown as ImageDoc,
    ]);
    const configColl = makeConfigMock();

    const testStage = defineStage({
      name: 'hash',
      targetVersion: 1,
      dependsOn: [],
      defaults: {
        concurrency: 1,
        maxAttempts: 3,
        paused: false,
        pausedOnFirstBoot: false,
        last_seen_target_version: 0,
      },
      handler: async () => ({ patch: { description: 'a cat' }, invalidates: ['meili'] }),
    });

    const { runOnce } = _test;
    await runOnce(
      testStage,
      { concurrency: 1, maxAttempts: 3, paused: false, last_seen_target_version: 1 },
      images,
      configColl,
    );

    const [doc] = await images.find({}).toArray();
    expect((doc as unknown as { description: string }).description).toBe('a cat');
    expect(doc?.stages?.hash?.version).toBe(1);
    // meili was reset to stale so its poll loop re-claims + reindexes.
    expect(doc?.stages?.meili?.version).toBe(0);
    expect(doc?.stages?.meili?.attempts).toBe(0);
    expect(doc?.stages?.meili?.dead).toBe(false);
    expect(doc?.stages?.meili?.last_error).toBeNull();
    expect(doc?.stages?.meili?.processed_at).toBeNull();
  });

  it('recovers a doc whose handler returned empty once then succeeded (#2172)', async () => {
    // Regression for the IMG_4204.HEIC incident: an empty Ollama response is
    // a retryable failure, so with maxAttempts 2 the first tick must leave the
    // doc claimable (attempts 1, dead false, diagnostic last_error) and the
    // second tick's success must complete the stage AND invalidate meili so
    // the recovered caption gets reindexed.
    const images = makeImagesMock([
      {
        abs_path: '/IMG_4204.HEIC',
        stages: {
          meili: {
            version: 6,
            attempts: 0,
            last_error: null,
            processed_at: new Date(),
            dead: false,
          },
        },
      } as unknown as ImageDoc,
    ]);
    const configColl = makeConfigMock();

    let call = 0;
    const testStage = defineStage({
      name: 'describe',
      targetVersion: 7,
      dependsOn: [],
      defaults: {
        concurrency: 1,
        maxAttempts: 2,
        paused: false,
        pausedOnFirstBoot: true,
        last_seen_target_version: 0,
      },
      handler: async () => {
        call++;
        if (call === 1) {
          throw new Error(
            'Ollama returned empty response (model=qwen3-vl:8b, http=200, done=true, done_reason=load, eval_count=0, total_duration_ms=42)',
          );
        }
        return { patch: { description: 'recovered caption' }, invalidates: ['meili'] };
      },
    });

    const { runOnce } = _test;
    const cfg = { concurrency: 1, maxAttempts: 2, paused: false, last_seen_target_version: 7 };

    await runOnce(testStage, cfg, images, configColl);
    let [doc] = await images.find({}).toArray();
    expect(doc?.stages?.describe?.attempts).toBe(1);
    expect(doc?.stages?.describe?.dead).toBe(false);
    expect(doc?.stages?.describe?.last_error).toContain('empty response');
    expect(doc?.stages?.describe?.last_error).toContain('done_reason=load');

    await runOnce(testStage, cfg, images, configColl);
    [doc] = await images.find({}).toArray();
    expect((doc as unknown as { description: string }).description).toBe('recovered caption');
    expect(doc?.stages?.describe?.version).toBe(7);
    expect(doc?.stages?.describe?.attempts).toBe(0);
    expect(doc?.stages?.describe?.dead).toBe(false);
    expect(doc?.stages?.describe?.last_error).toBeNull();
    expect(doc?.stages?.meili?.version).toBe(0);
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
