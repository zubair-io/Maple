/**
 * Runner-side retry backoff (#2729) and failure-timestamp (#2730) coverage.
 *
 * The bug these guard: before backoff, a failed attempt was eligible again on
 * the very next poll tick, so consecutive attempts landed milliseconds apart.
 * The attempt budget was therefore worthless against exactly the failures it
 * exists for — a provider restart, a poisoned connection pool (#2728), a model
 * load. With prod's `describe.maxAttempts: 2`, a one-second blip permanently
 * dead-lettered the asset.
 *
 * DB-free: uses the shared in-memory collection mocks. Note those mocks model
 * `$gt` / `$not` specifically so the claim-query gate is genuinely evaluated
 * here rather than silently ignored.
 */

import { describe, expect, it } from 'bun:test';
import { ObjectId } from 'mongodb';
import { _test, buildClaimQuery, defineStage, type ImageDoc } from './run-stage.ts';
import { elapseRetryBackoff, makeConfigMock, makeImagesMock } from './run-stage.test-helpers.ts';

const { runOnce } = _test;

function failingStage(opts: { maxAttempts: number; err: () => Error }) {
  return defineStage({
    name: 'hash',
    targetVersion: 1,
    dependsOn: [],
    defaults: {
      concurrency: 1,
      maxAttempts: opts.maxAttempts,
      paused: false,
      pausedOnFirstBoot: false,
      last_seen_target_version: 0,
    },
    handler: async () => {
      throw opts.err();
    },
  });
}

const cfgFor = (maxAttempts: number) => ({
  concurrency: 1,
  maxAttempts,
  paused: false,
  last_seen_target_version: 1,
});

async function only(images: ReturnType<typeof makeImagesMock>): Promise<ImageDoc> {
  return (await images.find({}).toArray())[0] as ImageDoc;
}

describe('claim query — retry backoff gate', () => {
  const now = new Date('2026-08-08T12:00:00Z');
  const q = buildClaimQuery('hash', 1, [], new Set(), undefined, now) as Record<string, unknown>;

  it('gates on next_attempt_at as a negation, not a comparison', () => {
    // `$lte` would exclude documents lacking the field entirely, which is
    // every row that has never failed and every row written before the field
    // existed. The negation is what makes this migration-free.
    expect(q['stages.hash.next_attempt_at']).toEqual({ $not: { $gt: now } });
  });
});

describe('runOnce — retry backoff', () => {
  it('parks a failed asset behind next_attempt_at instead of re-claiming it', async () => {
    const images = makeImagesMock([{ _id: new ObjectId() } as unknown as ImageDoc]);
    const configColl = makeConfigMock();
    const stage = failingStage({ maxAttempts: 5, err: () => new Error('provider down') });

    const claimed = await runOnce(stage, cfgFor(5), images, configColl);
    expect(claimed).toBe(1);

    const afterFailure = await only(images);
    expect(afterFailure.stages?.hash?.attempts).toBe(1);
    expect(afterFailure.stages?.hash?.dead).toBe(false);
    const gate = afterFailure.stages?.hash?.next_attempt_at as Date;
    expect(gate).toBeInstanceOf(Date);
    expect(gate.getTime()).toBeGreaterThan(Date.now());

    // The whole point: an immediate second tick claims nothing, so the two
    // attempts cannot land in the same instant.
    expect(await runOnce(stage, cfgFor(5), images, configColl)).toBe(0);
    expect((await only(images)).stages?.hash?.attempts).toBe(1);

    // ...and once the gate elapses, it is claimable again.
    await elapseRetryBackoff(images, 'hash');
    expect(await runOnce(stage, cfgFor(5), images, configColl)).toBe(1);
    expect((await only(images)).stages?.hash?.attempts).toBe(2);
  });

  it('stamps failed_at so last_error is datable', async () => {
    const images = makeImagesMock([{ _id: new ObjectId() } as unknown as ImageDoc]);
    const before = Date.now();
    await runOnce(
      failingStage({ maxAttempts: 5, err: () => new Error('boom') }),
      cfgFor(5),
      images,
      makeConfigMock(),
    );
    const failedAt = (await only(images)).stages?.hash?.failed_at as Date;
    expect(failedAt).toBeInstanceOf(Date);
    expect(failedAt.getTime()).toBeGreaterThanOrEqual(before);
  });

  it('clears the failure trail on a later success', async () => {
    const images = makeImagesMock([{ _id: new ObjectId() } as unknown as ImageDoc]);
    const configColl = makeConfigMock();
    let call = 0;
    const stage = defineStage({
      name: 'hash',
      targetVersion: 1,
      dependsOn: [],
      defaults: {
        concurrency: 1,
        maxAttempts: 5,
        paused: false,
        pausedOnFirstBoot: false,
        last_seen_target_version: 0,
      },
      handler: async () => {
        if (++call === 1) throw new Error('transient');
        return { patch: {} };
      },
    });

    await runOnce(stage, cfgFor(5), images, configColl);
    await elapseRetryBackoff(images, 'hash');
    await runOnce(stage, cfgFor(5), images, configColl);

    const doc = await only(images);
    // A stale gate would hold the asset's NEXT version bump hostage for the
    // remainder of the ladder; a stale error string would misreport a healthy
    // asset as failing.
    expect(doc.stages?.hash?.next_attempt_at ?? null).toBeNull();
    expect(doc.stages?.hash?.failed_at ?? null).toBeNull();
    expect(doc.stages?.hash?.last_error ?? null).toBeNull();
    expect(doc.stages?.hash?.attempts).toBe(0);
  });

  it('does not set a retry gate on the attempt that dead-letters', async () => {
    const images = makeImagesMock([{ _id: new ObjectId() } as unknown as ImageDoc]);
    await runOnce(
      failingStage({ maxAttempts: 1, err: () => new Error('fatal') }),
      cfgFor(1),
      images,
      makeConfigMock(),
    );
    const doc = await only(images);
    expect(doc.stages?.hash?.dead).toBe(true);
    expect(doc.stages?.hash?.next_attempt_at ?? null).toBeNull();
  });
});

describe('runOnce — terminal errors skip the attempt budget', () => {
  /** Shaped like `RemoteError`: the runner reads `retryable` structurally so
   * the generic runtime need not import one stage's provider types. */
  function terminal(message: string): Error {
    return Object.assign(new Error(message), { retryable: false });
  }

  it('dead-letters immediately when the error says it is not retryable', async () => {
    const images = makeImagesMock([{ _id: new ObjectId() } as unknown as ImageDoc]);
    await runOnce(
      failingStage({ maxAttempts: 5, err: () => terminal('Ollama 4xx: 400') }),
      cfgFor(5),
      images,
      makeConfigMock(),
    );
    const doc = await only(images);
    // A 4xx means the request itself is wrong — spending four more attempts
    // across a 20-minute ladder cannot produce a different answer.
    expect(doc.stages?.hash?.dead).toBe(true);
    expect(doc.stages?.hash?.attempts).toBe(1);
  });

  it('keeps the full budget for an error that says it IS retryable', async () => {
    const images = makeImagesMock([{ _id: new ObjectId() } as unknown as ImageDoc]);
    await runOnce(
      failingStage({
        maxAttempts: 5,
        err: () => Object.assign(new Error('Ollama 5xx: 500'), { retryable: true }),
      }),
      cfgFor(5),
      images,
      makeConfigMock(),
    );
    expect((await only(images)).stages?.hash?.dead).toBe(false);
  });

  it('keeps the full budget for a plain Error carrying no verdict', async () => {
    const images = makeImagesMock([{ _id: new ObjectId() } as unknown as ImageDoc]);
    await runOnce(
      failingStage({ maxAttempts: 5, err: () => new Error('who knows') }),
      cfgFor(5),
      images,
      makeConfigMock(),
    );
    expect((await only(images)).stages?.hash?.dead).toBe(false);
  });
});
