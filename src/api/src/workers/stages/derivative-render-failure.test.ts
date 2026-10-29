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
import { audioOnlyVideo } from '../../test-support/synth-video.ts';
import { ffmpegBinary } from '../../thumbs/video-poster.ts';

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

function damagedSince(): string | null {
  const asset = live.db.query(`SELECT damaged_since FROM assets WHERE id = ?`).get(assetId) as {
    damaged_since: string | null;
  };
  return asset.damaged_since;
}

function expectDeferredUndamaged(stage: string, targetVersion: number) {
  const row = stageRow(stage);
  expect(row.version).toBeLessThan(targetVersion);
  expect(row.attempts).toBe(0);
  expect(row.dead).toBe(0);
  expect(damagedSince()).toBeNull();
}

function expectDeadAndDamaged(stage: string, targetVersion: number) {
  const row = stageRow(stage);
  expect(row.version).toBeLessThan(targetVersion);
  expect(row.dead).toBe(1);
  expect(damagedSince()).not.toBeNull();
}

function runStageOnce(stage: StageConfig, maxAttempts: number) {
  return runOnce(stage, {
    concurrency: 1,
    maxAttempts,
    paused: false,
    last_seen_target_version: stage.targetVersion,
  });
}

async function runWithPool(stage: StageConfig, pool: unknown) {
  const previous = _setFfiPoolForTests(pool as never);
  try {
    await runStageOnce(stage, 1);
  } finally {
    _setFfiPoolForTests(previous);
  }
}

async function renameOriginal(filename: string) {
  await writeFile(path.join(dir, filename), Buffer.alloc(1024));
  run(live.db, `UPDATE asset_locations SET filename = ? WHERE asset_id = ?`, filename, assetId);
}

function resetStageRow(name: string) {
  run(
    live.db,
    `INSERT OR REPLACE INTO stage_state (asset_id, stage, version) VALUES (?, ?, 0)`,
    assetId,
    name,
  );
}

const STAGES = [
  ['thumb', thumbStage],
  ['preview', previewStage],
] as const;

describe.each(STAGES)('%s stage render outcomes', (name, stage) => {
  beforeEach(() => resetStageRow(name));

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
    expectDeadAndDamaged(name, stage.targetVersion);
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

  it('records a render done even when the original carries a future mtime', async () => {
    const original = path.join(dir, 'broken.jpg');
    await writeFile(original, await solidJpeg(64, 48, [10, 120, 200]));
    const anHourAhead = new Date(Date.now() + 3_600_000);
    await utimes(original, anHourAhead, anHourAhead);
    await runStageOnce(stage as unknown as StageConfig, 5);
    expect(stageRow(name).version).toBe(stage.targetVersion);
  });
});

describe.each(STAGES)('%s stage deferrals from the native pool', (name, stage) => {
  beforeEach(() => resetStageRow(name));

  it('defers a crashed child without tagging the original damaged', async () => {
    await runWithPool(stage as unknown as StageConfig, {
      available: () => true,
      poolSize: () => 1,
      renderBitmapThumbToFile: () => Promise.resolve({ ok: false, error: 'child exited' }),
    });
    expectDeferredUndamaged(name, stage.targetVersion);
  });

  it('defers without spending an attempt while the native decoder is missing', async () => {
    await runWithPool(stage as unknown as StageConfig, {
      available: () => false,
      poolSize: () => 1,
    });
    const row = stageRow(name);
    expect(row.version).toBeLessThan(stage.targetVersion);
    expect(row.attempts).toBe(0);
    expect(row.dead).toBe(0);
  });

  it('defers a RAW decode larger than the memory budget without spending an attempt', async () => {
    await renameOriginal('frame.cr2');
    const overBudget = () => Promise.reject(new DecodeMemoryBudgetError(8 * 1024 ** 3, 1024 ** 3));
    await runWithPool(stage as unknown as StageConfig, {
      available: () => true,
      poolSize: () => 1,
      renderThumbnailAvifToFile: overBudget,
      renderDevelopJpegToFile: overBudget,
    });
    expectDeferredUndamaged(name, stage.targetVersion);
    expect(stageRow(name).last_error).toContain('decode-exceeds-memory-budget');
  });

  it('defers an unsupported camera body without spending an attempt (#5499)', async () => {
    await renameOriginal('frame.3fr');
    await runWithPool(stage as unknown as StageConfig, {
      available: () => true,
      poolSize: () => 1,
      renderThumbnailAvifToFile: () => Promise.reject(new Error('render-failed')),
      renderDevelopJpegToFile: (rawPath: string) =>
        Promise.reject(developRejection('unsupported camera: Hasselblad Hasselblad H2D', rawPath)),
    });
    expectDeferredUndamaged(name, stage.targetVersion);
    expect(stageRow(name).last_error).toContain('camera-unsupported');
  });
});

describe.each(STAGES)('%s stage permanent source failures (#5513)', (name, stage) => {
  beforeEach(() => resetStageRow(name));

  it('dead-letters a .HEIC whose bytes are not HEIC and tags it damaged', async () => {
    await renameOriginal('IMG_1097_Original.HEIC');
    await runWithPool(stage as unknown as StageConfig, {
      available: () => true,
      poolSize: () => 1,
      renderBitmapThumbToFile: () =>
        Promise.resolve({ ok: false, error: 'input buffer is not a HEIC image' }),
    });
    expectDeadAndDamaged(name, stage.targetVersion);
    expect(stageRow(name).last_error).toContain('input buffer is not a HEIC image');
  });

  it('dead-letters a truncated QuickTime file and tags it damaged', async () => {
    if (!(await ffmpegBinary())) return;
    await renameOriginal('Sequence 01.mov');
    await runStageOnce(stage as unknown as StageConfig, 1);
    expectDeadAndDamaged(name, stage.targetVersion);
    expect(stageRow(name).last_error).toContain('moov atom not found');
  });

  it('marks an audio-only video handled without tagging it damaged', async () => {
    const ffmpeg = await ffmpegBinary();
    const clip = ffmpeg && (await audioOnlyVideo(ffmpeg, path.join(dir, '0008DD02.mov')));
    if (!clip) return;
    run(
      live.db,
      `UPDATE asset_locations SET filename = ? WHERE asset_id = ?`,
      '0008DD02.mov',
      assetId,
    );
    await runStageOnce(stage as unknown as StageConfig, 1);
    expect(stageRow(name)).toMatchObject({ version: stage.targetVersion, attempts: 0, dead: 0 });
    expect(damagedSince()).toBeNull();
  });
});
