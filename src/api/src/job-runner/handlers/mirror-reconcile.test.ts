/**
 * The "Reconcile now" handler against a real library and mirror on disk: one
 * run scans, copies what was missing, and leaves its progress on the row for
 * the status route; a mirror removed in the meantime makes it a no-op.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { replaceFolderDestinations } from '../../cloud-backup/local-mirror-bridge.ts';
import {
  createLiveTestDatabase,
  insertAsset,
  insertFolder,
  insertLocation,
  type LiveTestDatabase,
} from '../../db/sqlite/test-sqlite.test-helpers.ts';
import { clearMirrorRoots } from '../../fs/mirror-registry.ts';
import { invalidateLibraryRoots } from '../../indexer/libraries.cache.ts';
import { recordedAttempt } from '../../temporal/recorded-attempt.test-helpers.ts';
import { reconcileProgressOf } from '../../workers/mirror/reconcile-progress.ts';
import { executeJob } from '../execute-job.ts';
import { createJob, getJob } from '../jobs.repo.ts';

let live: LiveTestDatabase;
let primary: string;
let mirror: string;
let libraryId: string;

beforeEach(async () => {
  live = await createLiveTestDatabase();
  primary = mkdtempSync(join(tmpdir(), 'reconcile-primary-'));
  mirror = mkdtempSync(join(tmpdir(), 'reconcile-mirror-'));
  invalidateLibraryRoots();
  clearMirrorRoots();
  libraryId = insertFolder(live.db, { path: primary, slug: 'reconcile' });
  writeFileSync(join(primary, 'IMG.dng'), 'raw bytes');
  insertLocation(live.db, {
    assetId: insertAsset(live.db),
    libraryId,
    path: '',
    filename: 'IMG.dng',
  });
});

afterEach(() => {
  clearMirrorRoots();
  invalidateLibraryRoots();
  live.close();
  rmSync(primary, { recursive: true, force: true });
  rmSync(mirror, { recursive: true, force: true });
});

async function reconcileOnce() {
  const job = await createJob({ kind: 'mirror_reconcile', payload: {} });
  const outcome = await executeJob(job._id.toHexString(), recordedAttempt('reconcile'));
  return { outcome, job: (await getJob(job._id))! };
}

describe('mirror_reconcile', () => {
  it('scans, copies what the mirror is missing, and records the run on the row', async () => {
    await replaceFolderDestinations(libraryId, [{ path: mirror, enabled: true }]);

    const { outcome, job } = await reconcileOnce();

    expect(outcome).toEqual({ outcome: 'done' });
    expect(readFileSync(join(mirror, 'IMG.dng'), 'utf8')).toBe('raw bytes');
    const progress = reconcileProgressOf(job);
    expect(progress.phase).toBe('idle');
    expect(progress.scan).toMatchObject({ scanned: 1, toCopy: 1 });
    expect(progress.copy).toMatchObject({ total: 1, copied: 1, remaining: 0, errors: 0 });
    expect(progress.copiedLog).toEqual([join(primary, 'IMG.dng')]);
    expect(progress.finishedAt).not.toBeNull();
    expect(job.checkpoint).toHaveProperty('reconcile.phase', 'copying');
  });

  it('does nothing once no mirror is configured', async () => {
    const { outcome, job } = await reconcileOnce();

    expect(outcome).toEqual({ outcome: 'done' });
    expect(reconcileProgressOf(job)).toMatchObject({
      phase: 'idle',
      scan: { scanned: 0 },
      copy: { total: 0 },
    });
  });
});
