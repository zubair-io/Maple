// Tests for the `{ rearm }` StageResult (#2177). A handler that finds a
// prerequisite artefact missing — even though the upstream stage's version
// says it already ran — hands the doc back: the runner re-arms the upstream
// stage and leaves the current stage below target, so the `dependsOn` gate
// parks the doc until the upstream regenerates and the current stage then
// re-claims it. The claim-time attempt is kept, so a pair that never
// converges dead-letters at maxAttempts instead of ping-ponging forever.
//
// Sibling to run-stage.test.ts (which is at the file-size budget).
import { describe, expect, it } from 'bun:test';
import { ObjectId } from 'mongodb';
import { _test, defineStage, type ImageDoc, type StageState } from './run-stage.ts';
import { makeConfigMock, makeImagesMock } from './run-stage.test-helpers.ts';

const { runOnce } = _test;

function previewState(overrides: Partial<StageState> = {}): StageState {
  return {
    version: 4,
    attempts: 0,
    last_error: null,
    processed_at: null,
    dead: false,
    ...overrides,
  };
}

function docWithPreviewDone(): ImageDoc {
  return {
    _id: new ObjectId(),
    abs_path: '/img.raw',
    stages: { preview: previewState() },
  } as unknown as ImageDoc;
}

function rearmStage(opts: {
  maxAttempts: number;
  handler: () => Promise<
    { rearm: { stage: string; reason: string } } | { wrote: true } | { patch: {} }
  >;
  dependsOn?: string[];
}) {
  return defineStage({
    name: 'describe',
    targetVersion: 7,
    dependsOn: opts.dependsOn ?? ['preview'],
    defaults: {
      concurrency: 1,
      maxAttempts: opts.maxAttempts,
      paused: false,
      pausedOnFirstBoot: false,
      last_seen_target_version: 0,
    },
    handler: opts.handler,
  });
}

function cfg(maxAttempts: number) {
  return { concurrency: 1, maxAttempts, paused: false, last_seen_target_version: 7 };
}

describe('runOnce — { rearm } result', () => {
  it('re-arms the upstream stage and leaves the current stage below target', async () => {
    const images = makeImagesMock([docWithPreviewDone()]);
    const configColl = makeConfigMock();
    let calls = 0;
    const stage = rearmStage({
      maxAttempts: 5,
      handler: async () => {
        calls++;
        return { rearm: { stage: 'preview', reason: 'preview-missing' } };
      },
    });

    await runOnce(stage, cfg(5), images, configColl);
    const doc = (await images.find({}).toArray())[0] as unknown as ImageDoc;

    expect(calls).toBe(1);
    // Upstream stage reset — its poll loop will regenerate the artefact.
    expect(doc.stages?.preview?.version).toBe(0);
    expect(doc.stages?.preview?.attempts).toBe(0);
    expect(doc.stages?.preview?.dead).toBe(false);
    // Current stage NOT stamped done: version untouched, claim-time attempt
    // kept, operator-facing reason recorded.
    expect(doc.stages?.describe?.version ?? 0).toBeLessThan(7);
    expect(doc.stages?.describe?.attempts).toBe(1);
    expect(doc.stages?.describe?.dead).toBe(false);
    expect(doc.stages?.describe?.last_error).toBe('awaiting preview: preview-missing');

    // With preview re-armed to 0, the dependsOn gate parks the doc — the next
    // tick must NOT re-claim it (no busy ping-pong while preview regenerates).
    await runOnce(stage, cfg(5), images, configColl);
    expect(calls).toBe(1);
  });

  it('re-claims after the upstream stage regenerates, then completes cleanly', async () => {
    const doc = docWithPreviewDone();
    const images = makeImagesMock([doc]);
    const configColl = makeConfigMock();
    let previewPresent = false;
    const stage = rearmStage({
      maxAttempts: 5,
      handler: async () =>
        previewPresent
          ? { wrote: true }
          : { rearm: { stage: 'preview', reason: 'preview-missing' } },
    });

    await runOnce(stage, cfg(5), images, configColl);

    // Simulate the preview stage's re-run landing its artefact + version.
    previewPresent = true;
    await images.updateOne(
      { _id: (doc as { _id: ObjectId })._id },
      { $set: { 'stages.preview.version': 4 } },
    );

    await runOnce(stage, cfg(5), images, configColl);
    const after = (await images.find({}).toArray())[0] as unknown as ImageDoc;
    expect(after.stages?.describe?.version).toBe(7);
    expect(after.stages?.describe?.attempts).toBe(0);
    expect(after.stages?.describe?.dead).toBe(false);
    expect(after.stages?.describe?.last_error).toBeNull();
  });

  it('dead-letters at maxAttempts and stops re-arming the upstream stage', async () => {
    const doc = docWithPreviewDone();
    const images = makeImagesMock([doc]);
    const configColl = makeConfigMock();
    const stage = rearmStage({
      maxAttempts: 2,
      handler: async () => ({ rearm: { stage: 'preview', reason: 'preview-missing' } }),
    });

    // Attempt 1: rearm. Simulate preview "succeeding" again without the
    // artefact appearing (the pathological non-converging pair).
    await runOnce(stage, cfg(2), images, configColl);
    await images.updateOne(
      { _id: (doc as { _id: ObjectId })._id },
      { $set: { 'stages.preview.version': 4 } },
    );

    // Attempt 2 crosses maxAttempts: dead-letter, and do NOT reset preview
    // again — this stage can no longer claim the doc, so another upstream
    // re-run would be pure churn.
    await runOnce(stage, cfg(2), images, configColl);
    const after = (await images.find({}).toArray())[0] as unknown as ImageDoc;
    expect(after.stages?.describe?.dead).toBe(true);
    expect(after.stages?.describe?.attempts).toBe(2);
    expect(after.stages?.describe?.last_error).toBe('awaiting preview: preview-missing');
    expect(after.stages?.preview?.version).toBe(4);

    // Dead → parked out of the claim query entirely.
    await runOnce(stage, cfg(2), images, configColl);
    expect((await images.find({}).toArray())[0]?.stages?.describe?.attempts).toBe(2);
  });

  it('rejects a { rearm } naming a stage the current stage does not depend on', async () => {
    const images = makeImagesMock([
      { _id: new ObjectId(), abs_path: '/x.jpg' } as unknown as ImageDoc,
    ]);
    const configColl = makeConfigMock();
    const stage = rearmStage({
      maxAttempts: 3,
      dependsOn: [],
      handler: async () => ({ rearm: { stage: 'preview', reason: 'preview-missing' } }),
    });

    // Programming error → thrown inside the work unit, caught as a failed
    // attempt; the upstream stage is never touched.
    await runOnce(stage, cfg(3), images, configColl);
    const doc = (await images.find({}).toArray())[0] as unknown as ImageDoc;
    expect(doc.stages?.describe?.last_error).toMatch(/does not depend/);
    expect(doc.stages?.preview ?? undefined).toBeUndefined();
  });
});
