// Runner-level coverage for `StageResult.invalidates` and the #2172
// empty-response-then-recovery regression. Sibling of run-stage.test.ts
// (split out to keep that file under the file-size budget, same as
// run-stage.crash-claim.test.ts and friends).

import { describe, expect, it } from 'bun:test';
import { _test, defineStage, type ImageDoc } from './run-stage.ts';
import { makeConfigMock, makeImagesMock } from './run-stage.test-helpers.ts';

const { runOnce } = _test;

/** A doc whose meili stage already completed — the describe→meili shape: the
 * caption lands AFTER the search index was built, so the patch result asks
 * the runner to mark meili stale in the same atomic write. */
function docWithCompletedMeili(absPath: string): ImageDoc {
  return {
    abs_path: absPath,
    stages: {
      meili: {
        version: 6,
        attempts: 0,
        last_error: null,
        processed_at: new Date(),
        dead: false,
      },
    },
  } as unknown as ImageDoc;
}

describe('StageResult.invalidates', () => {
  it("resets the stages listed in a patch result's `invalidates` (#2172)", async () => {
    const images = makeImagesMock([docWithCompletedMeili('/img1.raw')]);
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

    await runOnce(
      testStage,
      { concurrency: 1, maxAttempts: 3, paused: false, last_seen_target_version: 1 },
      images,
      configColl,
    );

    const [doc] = await images.find({}).toArray();
    expect((doc as unknown as { description: string }).description).toBe('a cat');
    expect(doc!.stages!.hash).toMatchObject({ version: 1 });
    // meili was reset to stale so its poll loop re-claims + reindexes.
    expect(doc!.stages!.meili).toMatchObject({
      version: 0,
      attempts: 0,
      dead: false,
      last_error: null,
      processed_at: null,
    });
  });

  it('rejects invalidates names that would corrupt Mongo $set paths', async () => {
    // A `.`/`$`-bearing or empty name would silently create unintended nested
    // fields (or throw mid-update) — the runner must fail the attempt with a
    // clear error instead of writing a malformed update.
    const images = makeImagesMock([docWithCompletedMeili('/img1.raw')]);
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
      handler: async () => ({ patch: { description: 'a cat' }, invalidates: ['meili.version'] }),
    });

    await runOnce(
      testStage,
      { concurrency: 1, maxAttempts: 3, paused: false, last_seen_target_version: 1 },
      images,
      configColl,
    );

    const [doc] = await images.find({}).toArray();
    // The attempt failed cleanly: no patch landed, error names the bad value.
    expect((doc as unknown as { description?: string }).description).toBeUndefined();
    expect(doc!.stages!.hash!.last_error).toContain('invalid stage name');
    expect(doc!.stages!.hash!.last_error).toContain('meili.version');
    // meili's completed state was left untouched.
    expect(doc!.stages!.meili).toMatchObject({ version: 6 });
  });

  it('recovers a doc whose handler returned empty once then succeeded (#2172)', async () => {
    // Regression for the IMG_4204.HEIC incident: an empty Ollama response is
    // a retryable failure, so with maxAttempts 2 the first tick must leave the
    // doc claimable (attempts 1, dead false, diagnostic last_error) and the
    // second tick's success must complete the stage AND invalidate meili so
    // the recovered caption gets reindexed.
    const images = makeImagesMock([docWithCompletedMeili('/IMG_4204.HEIC')]);
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

    const cfg = { concurrency: 1, maxAttempts: 2, paused: false, last_seen_target_version: 7 };

    await runOnce(testStage, cfg, images, configColl);
    const [afterFailure] = await images.find({}).toArray();
    expect(afterFailure!.stages!.describe).toMatchObject({ attempts: 1, dead: false });
    expect(afterFailure!.stages!.describe!.last_error).toContain('empty response');
    expect(afterFailure!.stages!.describe!.last_error).toContain('done_reason=load');

    await runOnce(testStage, cfg, images, configColl);
    const [afterRetry] = await images.find({}).toArray();
    expect((afterRetry as unknown as { description: string }).description).toBe(
      'recovered caption',
    );
    expect(afterRetry!.stages!.describe).toMatchObject({
      version: 7,
      attempts: 0,
      dead: false,
      last_error: null,
    });
    expect(afterRetry!.stages!.meili).toMatchObject({ version: 0 });
  });
});
