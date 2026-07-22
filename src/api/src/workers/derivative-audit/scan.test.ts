import { describe, expect, it, beforeAll, afterAll } from 'bun:test';
import { ObjectId } from 'mongodb';
// Mirror-aware wrapper per the fs-import guardrail (temp-path ops; no-op mirror).
import { mkdtemp, mkdir, writeFile, rm } from '../../fs/mirrored.ts';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { setupAuditMongo } from './test-support.ts';
import { runDerivativeAuditOnce } from './scan.ts';

const h = setupAuditMongo(`maple_derivative_audit_scan_test_${process.pid}`);
let root: string;

beforeAll(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'audit-scan-'));
});
afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

/** Original present at its (new) path; NO .maple derivatives there — the exact
 * post-move drift. Stages all say "done". */
async function seedMovedAsset(lib: ObjectId): Promise<void> {
  await mkdir(path.join(root, 'y2024'), { recursive: true });
  await writeFile(path.join(root, 'y2024', 'p.dng'), 'raw');
  await h.db.collection('assets').insertOne({
    _id: new ObjectId(),
    maple_id: 'deadbeef',
    fileinfo: [{ library_id: lib, path: 'y2024', filename: 'p.dng' }],
    live_location_count: 1,
    size: 3,
    mtime: 1,
    rating: 0,
    flag: 0,
    color_label: '',
    indexed_at: '',
    description: 'a photo',
    stages: {
      thumb: { version: 3, attempts: 0, last_error: null, processed_at: null, dead: false },
      preview: { version: 4, attempts: 0, last_error: null, processed_at: null, dead: false },
      describe: { version: 7, attempts: 0, last_error: null, processed_at: null, dead: false },
      'cf-thumb-sync': {
        version: 1,
        attempts: 0,
        last_error: null,
        processed_at: null,
        dead: false,
      },
    },
  } as never);
}

describe('runDerivativeAuditOnce', () => {
  it('re-arms thumb + preview for a moved asset whose derivatives are gone', async () => {
    if (!h.mongoReachable) return;
    const lib = await h.addLibrary(root);
    await seedMovedAsset(lib);
    const summary = await runDerivativeAuditOnce({ deep_r2_enabled: false });
    expect(summary.scanned).toBe(1);
    expect(summary.byStage.thumb).toBe(1);
    expect(summary.byStage.preview).toBe(1);
    const doc = await h.db.collection('assets').findOne({ maple_id: 'deadbeef' });
    expect(doc?.stages.thumb.version).toBe(0);
    expect(doc?.stages.preview.version).toBe(0);
    expect(doc?.stages.describe.version).toBe(7); // description present → untouched
    expect(doc?.derivative_audit.thumb.attempts).toBe(1);
  });

  it('stops re-arming after AUDIT_MAX_ATTEMPTS (cooldown)', async () => {
    if (!h.mongoReachable) return;
    const lib = await h.addLibrary(root);
    await seedMovedAsset(lib);
    for (let i = 0; i < 4; i++) {
      // No real workers regenerate here, so the drift persists — the auditor
      // must stop after the ceiling. Reset versions to "done" each round to
      // mimic the stage re-running + skipping without producing output.
      await h.db
        .collection('assets')
        .updateOne(
          { maple_id: 'deadbeef' },
          { $set: { 'stages.thumb.version': 3, 'stages.preview.version': 4 } },
        );
      await runDerivativeAuditOnce({ deep_r2_enabled: false });
    }
    const doc = await h.db.collection('assets').findOne({ maple_id: 'deadbeef' });
    expect(doc?.derivative_audit.thumb.attempts).toBe(3); // capped, not 4
  });

  it('preserves the cooldown mark while a re-armed stage sits queued below target', async () => {
    if (!h.mongoReachable) return;
    const lib = await h.addLibrary(root);
    await seedMovedAsset(lib);
    // Pass 1: derivatives missing, stages at target → re-arm to version 0, mark=1.
    await runDerivativeAuditOnce({ deep_r2_enabled: false });
    const afterFirst = await h.db.collection('assets').findOne({ maple_id: 'deadbeef' });
    expect(afterFirst?.stages.thumb.version).toBe(0);
    expect(afterFirst?.derivative_audit.thumb.attempts).toBe(1);
    // Pass 2: no worker regenerated, so stages are still at version 0 (queued,
    // below target). The auditor must leave the mark ALONE — not clear it (which
    // would reset the loop guard) and not bump it.
    await runDerivativeAuditOnce({ deep_r2_enabled: false });
    const afterSecond = await h.db.collection('assets').findOne({ maple_id: 'deadbeef' });
    expect(afterSecond?.derivative_audit.thumb.attempts).toBe(1); // preserved, not cleared/bumped
  });

  it('honors max_resets_per_pass', async () => {
    if (!h.mongoReachable) return;
    const lib = await h.addLibrary(root);
    await seedMovedAsset(lib);
    const summary = await runDerivativeAuditOnce({
      deep_r2_enabled: false,
      max_resets_per_pass: 1,
    });
    expect(summary.reArmed).toBe(1); // stopped after one stage reset
  });
});
