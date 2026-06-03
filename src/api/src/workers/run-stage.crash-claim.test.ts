/**
 * Crash-attributable claim tests (#897).
 *
 * The worker tier runs native code (onnx, libraw, sharp) that can `abort()` the
 * whole process — an UNCATCHABLE death the stage's try/catch never observes.
 * Before #897 the claim was a read-only `find()` and `attempts` was incremented
 * only in the catch, so an asset that aborted the worker mid-handler was never
 * dead-lettered and got re-claimed on every respawn → permanent SIGABRT loop.
 *
 * These tests pin the two guarantees that break that loop:
 *   1. the attempt is PERSISTED before the handler runs (so a crash counts), and
 *   2. a doc that reached maxAttempts without ever being marked done/dead (the
 *      residue of N crashes) is dead-lettered instead of re-dispatched.
 *
 * DB-free — uses the same in-memory collection mock as run-stage.test.ts.
 */

import { describe, expect, it } from 'bun:test';
import { ObjectId } from 'mongodb';
import { _test, defineStage, type ImageDoc } from './run-stage.ts';
import { makeConfigMock, makeImagesMock } from './run-stage.test-helpers.ts';

const defaults = {
  concurrency: 1,
  maxAttempts: 3,
  paused: false,
  pausedOnFirstBoot: false,
  last_seen_target_version: 0,
};

function cfg(maxAttempts = 3) {
  return { concurrency: 1, maxAttempts, paused: false, last_seen_target_version: 1 };
}

describe('runOnce — crash-attributable claims (#897)', () => {
  it('persists the attempt BEFORE running the handler, so an uncatchable crash counts', async () => {
    const id = new ObjectId();
    const images = makeImagesMock([{ _id: id, abs_path: '/poison.dng' } as unknown as ImageDoc]);
    const configColl = makeConfigMock();

    // The handler observes the state that would SURVIVE a SIGABRT: by the time
    // the handler body runs, `attempts` must already reflect this claim.
    let attemptsSeenMidHandler: number | undefined;
    const stage = defineStage({
      name: 'thumb',
      targetVersion: 1,
      dependsOn: [],
      defaults,
      handler: async () => {
        const live = await images.findOne({ _id: id });
        attemptsSeenMidHandler = live?.stages?.thumb?.attempts;
        return { wrote: true };
      },
    });

    await _test.runOnce(stage, cfg(), images, configColl);

    expect(attemptsSeenMidHandler).toBe(1);
    // A clean success still resets the counter.
    const doc = await images.findOne({ _id: id });
    expect(doc?.stages?.thumb?.attempts).toBe(0);
    expect(doc?.stages?.thumb?.version).toBe(1);
  });

  it('dead-letters a doc that hit maxAttempts via crashes (never marked done/dead) and stops dispatching it', async () => {
    const id = new ObjectId();
    // The residue of 3 worker aborts: attempts reached the cap, but `dead` was
    // never set (the abort skipped the catch) and the version never advanced.
    const images = makeImagesMock([
      {
        _id: id,
        abs_path: '/poison.dng',
        stages: {
          thumb: { version: 0, attempts: 3, last_error: null, processed_at: null, dead: false },
        },
      } as unknown as ImageDoc,
    ]);
    const configColl = makeConfigMock();

    let handlerCalls = 0;
    const stage = defineStage({
      name: 'thumb',
      targetVersion: 1,
      dependsOn: [],
      tagsDamagedOnDeadLetter: true,
      defaults,
      handler: async () => {
        handlerCalls++;
        return { wrote: true };
      },
    });

    await _test.runOnce(stage, cfg(3), images, configColl);

    // The loop is broken: the poison asset is NOT re-dispatched...
    expect(handlerCalls).toBe(0);
    // ...it's dead-lettered + surfaced in the Damaged list for the operator.
    const doc = await images.findOne({ _id: id });
    expect(doc?.stages?.thumb?.dead).toBe(true);
    expect(doc?.damaged?.stage).toBe('thumb');
    expect(typeof doc?.damaged?.since).toBe('string');
  });

  it('dead-letters a crash-exhausted doc WITHOUT damaging it on a non-file stage', async () => {
    const id = new ObjectId();
    const images = makeImagesMock([
      {
        _id: id,
        abs_path: '/x.jpg',
        stages: {
          describe: { version: 0, attempts: 2, last_error: null, processed_at: null, dead: false },
        },
      } as unknown as ImageDoc,
    ]);
    const configColl = makeConfigMock();

    let handlerCalls = 0;
    const stage = defineStage({
      // No tagsDamagedOnDeadLetter — a describe/geocode dead-letter must not
      // imply the file itself is damaged, even when reached via a crash.
      name: 'describe',
      targetVersion: 1,
      dependsOn: [],
      defaults,
      handler: async () => {
        handlerCalls++;
        return { wrote: true };
      },
    });

    await _test.runOnce(stage, cfg(2), images, configColl);

    expect(handlerCalls).toBe(0);
    const doc = await images.findOne({ _id: id });
    expect(doc?.stages?.describe?.dead).toBe(true);
    expect(doc?.damaged ?? null).toBeNull();
  });
});
