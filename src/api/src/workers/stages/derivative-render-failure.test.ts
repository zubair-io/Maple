/**
 * #5474: a thumb or preview render that leaves no file must not be recorded
 * as done at the target version. Only an original the decoder refuses goes
 * through the runner's retry → dead-letter → damaged path; a server-side
 * failure (unwritable cache, crashed child, missing decoder) defers without
 * spending attempts and is never tagged damaged. Real SQLite, real temp
 * library, real FFI child.
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { chmod, mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import thumbStage from './thumb.ts';
import previewStage from './preview.ts';
import {
  createLiveTestDatabase,
  insertAsset,
  insertFolder,
  insertLocation,
  run,
  type LiveTestDatabase,
} from '../../db/sqlite/test-sqlite.test-helpers.ts';
import { invalidateLibraryRoots } from '../../indexer/libraries.cache.ts';
import { runOnce, type StageConfig } from '../run-stage.ts';
import { _setFfiPoolForTests } from '../../ffi/ffi-pool.ts';
import { DecodeMemoryBudgetError } from '../../ffi/decode-memory-budget.ts';
import { developRejection } from '../../ffi/unsupported-camera.ts';
import { solidJpeg } from '../../test-support/synth-image.ts';

let live: LiveTestDatabase;
let dir = '';
let assetId = '';

beforeEach(async () => {
  live = await createLiveTestDatabase();
  dir = await mkdtemp(path.join(os.tmpdir(), 'derivative-failure-'));
  const libraryId = insertFolder(live.db, { path: dir });
  invalidateLibraryRoots();
  await writeFile(path.join(dir, 'broken.jpg'), Buffer.from('\xff\xd8not a jpeg', 'latin1'));
  assetId = insertAsset(live.db);
  insertLocation(live.db, { assetId, libraryId, path: '', filename: 'broken.jpg' });
  for (const stage of ['exif', 'thumb']) {
    run(
      live.db,
      `INSERT INTO stage_state (asset_id, stage, version) VALUES (?, ?, 99)`,
      assetId,
      stage,
    );
  }
});

afterEach(async () => {
  invalidateLibraryRoots();
  live.close();
  await rm(dir, { recursive: true, force: true });
});

function stageRow(stage: string) {
  return live.db
    .query(
      `SELECT version, attempts, last_error, dead FROM stage_state WHERE asset_id = ? AND stage = ?`,
    )
    .get(assetId, stage) as { version: number; attempts: number; last_error: string; dead: number };
}

function expectDeferredUndamaged(stage: string, targetVersion: number) {
  const row = stageRow(stage);
  expect(row.version).toBeLessThan(targetVersion);
  expect(row.attempts).toBe(0);
  expect(row.dead).toBe(0);
  const asset = live.db.query(`SELECT damaged_since FROM assets WHERE id = ?`).get(assetId) as {
    damaged_since: string | null;
  };
  expect(asset.damaged_since).toBeNull();
}

function runStageOnce(stage: StageConfig, maxAttempts: number) {
  return runOnce(stage, {
    concurrency: 1,
    maxAttempts,
    paused: false,
    last_seen_target_version: stage.targetVersion,
  });
}

describe.each([
  ['thumb', thumbStage],
  ['preview', previewStage],
] as const)('%s stage render outcomes', (name, stage) => {
  beforeEach(() => {
    run(
      live.db,
      `INSERT OR REPLACE INTO stage_state (asset_id, stage, version) VALUES (?, ?, 0)`,
      assetId,
      name,
    );
  });

  it('stays below target with the decode error recorded, so it retries', async () => {
    await runStageOnce(stage as unknown as StageConfig, 5);
    const row = stageRow(name);
    expect(row.version).toBeLessThan(stage.targetVersion);
    expect(row.attempts).toBe(1);
    expect(row.dead).toBe(0);
    expect(row.last_error).toContain('rawler failed to decode');
  });

  it('dead-letters and tags the asset damaged once out of attempts', async () => {
    await runStageOnce(stage as unknown as StageConfig, 1);
    const row = stageRow(name);
    expect(row.version).toBeLessThan(stage.targetVersion);
    expect(row.dead).toBe(1);
    const asset = live.db.query(`SELECT damaged_since FROM assets WHERE id = ?`).get(assetId) as {
      damaged_since: string | null;
    };
    expect(asset.damaged_since).not.toBeNull();
  });

  it('defers a crashed child without tagging the original damaged', async () => {
    const crashedChild = {
      available: () => true,
      poolSize: () => 1,
      renderBitmapThumbToFile: () => Promise.resolve({ ok: false, error: 'child exited' }),
    };
    const previous = _setFfiPoolForTests(crashedChild as never);
    try {
      await runStageOnce(stage as unknown as StageConfig, 1);
    } finally {
      _setFfiPoolForTests(previous);
    }
    expectDeferredUndamaged(name, stage.targetVersion);
  });

  it('defers a read-only cache directory without tagging the original damaged', async () => {
    await writeFile(path.join(dir, 'broken.jpg'), await solidJpeg(64, 48, [10, 120, 200]));
    const cacheRoot = path.join(dir, '.maple');
    await mkdir(cacheRoot, { recursive: true });
    await chmod(cacheRoot, 0o500);
    try {
      await runStageOnce(stage as unknown as StageConfig, 1);
    } finally {
      await chmod(cacheRoot, 0o700);
    }
    expectDeferredUndamaged(name, stage.targetVersion);
  });

  it('defers without spending an attempt while the native decoder is missing', async () => {
    const previous = _setFfiPoolForTests({ available: () => false, poolSize: () => 1 } as never);
    try {
      await runStageOnce(stage as unknown as StageConfig, 1);
    } finally {
      _setFfiPoolForTests(previous);
    }
    const row = stageRow(name);
    expect(row.version).toBeLessThan(stage.targetVersion);
    expect(row.attempts).toBe(0);
    expect(row.dead).toBe(0);
  });

  it('defers a RAW decode larger than the memory budget without spending an attempt', async () => {
    await writeFile(path.join(dir, 'frame.cr2'), Buffer.alloc(1024));
    run(live.db, `UPDATE asset_locations SET filename = 'frame.cr2' WHERE asset_id = ?`, assetId);
    const overBudget = () => Promise.reject(new DecodeMemoryBudgetError(8 * 1024 ** 3, 1024 ** 3));
    const previous = _setFfiPoolForTests({
      available: () => true,
      poolSize: () => 1,
      renderThumbnailAvifToFile: overBudget,
      renderDevelopJpegToFile: overBudget,
    } as never);
    try {
      await runStageOnce(stage as unknown as StageConfig, 1);
    } finally {
      _setFfiPoolForTests(previous);
    }
    expectDeferredUndamaged(name, stage.targetVersion);
    expect(stageRow(name).last_error).toContain('decode-exceeds-memory-budget');
  });

  it('defers an unsupported camera body without spending an attempt (#5499)', async () => {
    await writeFile(path.join(dir, 'frame.3fr'), Buffer.alloc(1024));
    run(live.db, `UPDATE asset_locations SET filename = 'frame.3fr' WHERE asset_id = ?`, assetId);
    const previous = _setFfiPoolForTests({
      available: () => true,
      poolSize: () => 1,
      renderThumbnailAvifToFile: () => Promise.reject(new Error('render-failed')),
      renderDevelopJpegToFile: (rawPath: string) =>
        Promise.reject(developRejection('unsupported camera: Hasselblad Hasselblad H2D', rawPath)),
    } as never);
    try {
      await runStageOnce(stage as unknown as StageConfig, 1);
    } finally {
      _setFfiPoolForTests(previous);
    }
    expectDeferredUndamaged(name, stage.targetVersion);
    expect(stageRow(name).last_error).toContain('camera-unsupported');
  });

  it('records a render done even when the original carries a future mtime', async () => {
    const original = path.join(dir, 'broken.jpg');
    await writeFile(original, await solidJpeg(64, 48, [10, 120, 200]));
    const anHourAhead = new Date(Date.now() + 3_600_000);
    await utimes(original, anHourAhead, anHourAhead);
    await runStageOnce(stage as unknown as StageConfig, 5);
    expect(stageRow(name).version).toBe(stage.targetVersion);
  });
});
