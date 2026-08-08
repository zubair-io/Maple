/**
 * Poll-loop integration tests for the stage runner.
 *
 * Split out of `run-stage.test.ts` when the retry-backoff work (#2729) pushed
 * that file past the 600-line hard budget. This block is the natural seam: it
 * is the only part of the suite that drives `runOnce` end to end against the
 * in-memory collection mocks, while the rest unit-tests pure helpers
 * (`bootConfig`, `versionBumpReset`, `buildClaimQuery`, `defineStage`).
 *
 * Per-asset retry backoff means consecutive `runOnce` calls no longer re-claim
 * a failed doc, so tests that walk an asset through several attempts call
 * `elapseRetryBackoff` between ticks to stand in for the wall-clock wait.
 */

import { describe, expect, it } from 'bun:test';
import { ObjectId } from 'mongodb';
import { _test, defineStage, deriveBatchSize, type ImageDoc } from './run-stage.ts';
import { elapseRetryBackoff, makeConfigMock, makeImagesMock } from './run-stage.test-helpers.ts';

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
    // Each retry is gated by the backoff (#2729), so the elapse between ticks
    // is what production's wall-clock provides. Without it the 2nd and 3rd
    // ticks would claim nothing and this would assert a sequence the runner
    // can no longer produce.
    await runOnce(testStage, cfg, images, configColl);
    await elapseRetryBackoff(images, 'hash');
    await runOnce(testStage, cfg, images, configColl);
    await elapseRetryBackoff(images, 'hash');
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
    await elapseRetryBackoff(images, 'exif');

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
});
