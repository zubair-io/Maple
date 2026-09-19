/**
 * The describe re-drive for rows skipped on a missing preview.
 *
 * Before #2177 a describe run that found the 1280-px preview absent returned a
 * terminal skip, and a skip writes the stage's target version — so every asset
 * that hit that branch is stamped done with no caption and nothing queued to
 * regenerate its preview. This migration resets exactly those rows so the new
 * code decides per asset: re-arm the preview stage (drift), or re-skip
 * terminally (no preview can exist, e.g. video on a host with no ffmpeg).
 *
 * Two boundaries matter. The preview stage is deliberately NOT reset — whether
 * it needs a re-run is the describe handler's call, and resetting it here would
 * re-render previews that are present and fine. And the done-marker is what
 * terminates the sweep: the terminal case re-writes the same skip string, so
 * without the marker the migration would re-arm the very skip it just caused,
 * forever.
 */

import { describe, it, expect } from 'bun:test';
import {
  redrivePreviewMissingDescribe,
  PREVIEW_MISSING_REDRIVE_VERSION,
} from './redrive-preview-missing-describe.ts';
import {
  assetRow,
  createLibrary,
  seedAsset,
  seedLocation,
  stageRow,
  type MigrationLibrary,
} from './migration.test-helpers.ts';

const SEEDED_STAGES = ['exif', 'thumb', 'preview', 'describe'] as const;

/** The version each seeded stage sits at, so an untouched one is recognisable. */
const SEEDED_VERSIONS: Record<string, number> = {
  exif: 1,
  thumb: 3,
  preview: 4,
  describe: 7,
};

function seedRow(
  library: MigrationLibrary,
  filename: string,
  options: { describeLastError?: string | null; redriven?: boolean } = {},
): string {
  const id = seedAsset(library.db, {
    stages: SEEDED_STAGES,
    previewMissingRedriveVersion: options.redriven ? PREVIEW_MISSING_REDRIVE_VERSION : null,
  });
  seedLocation(library.db, { assetId: id, libraryId: library.folderId, path: 'media', filename });
  for (const stage of SEEDED_STAGES) {
    library.db.run(
      `UPDATE stage_state SET version = ?, processed_at = '2026-01-01T00:00:00.000Z'
        WHERE asset_id = ? AND stage = ?`,
      [SEEDED_VERSIONS[stage]!, id, stage],
    );
  }
  library.db.run(
    `UPDATE stage_state SET last_error = ? WHERE asset_id = ? AND stage = 'describe'`,
    [options.describeLastError ?? null, id],
  );
  return id;
}

const SKIPPED = { describeLastError: 'skip: preview-missing' };

describe('redrivePreviewMissingDescribe — selection', () => {
  it('counts only rows skipped on a missing preview', async () => {
    using library = await createLibrary('maple-redrive-');
    seedRow(library, 'drifted.dng', SKIPPED);
    seedRow(library, 'captioned.dng');
    seedRow(library, 'stub.eip', { describeLastError: 'skip: stub-file' });
    seedRow(library, 'flaky.dng', { describeLastError: 'LLM timeout' });

    expect(await redrivePreviewMissingDescribe.countRemaining()).toBe(1);
  });

  it('excludes rows already stamped at the current re-drive version', async () => {
    using library = await createLibrary('maple-redrive-');
    seedRow(library, 'done.dng', { ...SKIPPED, redriven: true });
    seedRow(library, 'todo.dng', SKIPPED);

    expect(await redrivePreviewMissingDescribe.countRemaining()).toBe(1);
  });
});

describe('redrivePreviewMissingDescribe — runBatch', () => {
  it('resets the describe stage to unprocessed and stamps the marker', async () => {
    using library = await createLibrary('maple-redrive-');
    const id = seedRow(library, 'drifted.dng', SKIPPED);

    expect(await redrivePreviewMissingDescribe.runBatch(50)).toEqual({ processed: 1, errors: 0 });

    expect(stageRow(library.db, id, 'describe')).toEqual({
      version: 0,
      attempts: 0,
      last_error: null,
      dead: 0,
    });
    expect(assetRow(library.db, id)!.preview_missing_redrive_version).toBe(
      PREVIEW_MISSING_REDRIVE_VERSION,
    );
  });

  it('leaves the preview stage — and every other stage — untouched', async () => {
    using library = await createLibrary('maple-redrive-');
    const id = seedRow(library, 'drifted.dng', SKIPPED);

    await redrivePreviewMissingDescribe.runBatch(50);

    expect(stageRow(library.db, id, 'preview')!.version).toBe(4);
    expect(stageRow(library.db, id, 'thumb')!.version).toBe(3);
    expect(stageRow(library.db, id, 'exif')!.version).toBe(1);
  });

  it('does not touch rows that skipped for other reasons or completed', async () => {
    using library = await createLibrary('maple-redrive-');
    const captioned = seedRow(library, 'captioned.dng');
    const stub = seedRow(library, 'stub.eip', { describeLastError: 'skip: stub-file' });
    seedRow(library, 'sweep.dng', SKIPPED);

    await redrivePreviewMissingDescribe.runBatch(50);

    expect(stageRow(library.db, captioned, 'describe')!.version).toBe(7);
    expect(assetRow(library.db, captioned)!.preview_missing_redrive_version).toBeNull();
    expect(stageRow(library.db, stub, 'describe')!.version).toBe(7);
    expect(stageRow(library.db, stub, 'describe')!.last_error).toBe('skip: stub-file');
  });

  it('honours batchSize', async () => {
    using library = await createLibrary('maple-redrive-');
    seedRow(library, 'a.dng', SKIPPED);
    seedRow(library, 'b.dng', SKIPPED);
    seedRow(library, 'c.dng', SKIPPED);

    expect((await redrivePreviewMissingDescribe.runBatch(2)).processed).toBe(2);
    expect(await redrivePreviewMissingDescribe.countRemaining()).toBe(1);
  });

  it('does not re-drive a row a worker re-stamped between the read and the write', async () => {
    // The skip-marker half of the predicate is re-asserted at write time. A row
    // whose describe stage was resolved in that window must keep its fresh
    // state and must not be counted as processed.
    using library = await createLibrary('maple-redrive-');
    const raced = seedRow(library, 'raced.dng', SKIPPED);
    library.db.run(
      `UPDATE stage_state SET last_error = NULL, version = 8
        WHERE asset_id = ? AND stage = 'describe'`,
      [raced],
    );

    // The candidate read happens inside runBatch, so simulate the race by
    // resolving the row first and confirming the write declines it.
    expect(await redrivePreviewMissingDescribe.runBatch(50)).toEqual({ processed: 0, errors: 0 });
    expect(stageRow(library.db, raced, 'describe')!.version).toBe(8);
    expect(assetRow(library.db, raced)!.preview_missing_redrive_version).toBeNull();
  });

  it('converges: a row that re-skips under the new code does not re-enter', async () => {
    using library = await createLibrary('maple-redrive-');
    const id = seedRow(library, 'video-no-ffmpeg.mov', SKIPPED);

    await redrivePreviewMissingDescribe.runBatch(50);
    expect(await redrivePreviewMissingDescribe.countRemaining()).toBe(0);

    // The terminal case (video on a no-ffmpeg host) re-writes the SAME skip
    // string when describe re-runs. The done-marker is what keeps that out of
    // the candidate set.
    library.db.run(
      `UPDATE stage_state SET version = 7, last_error = 'skip: preview-missing'
        WHERE asset_id = ? AND stage = 'describe'`,
      [id],
    );
    expect(await redrivePreviewMissingDescribe.countRemaining()).toBe(0);
    expect(await redrivePreviewMissingDescribe.runBatch(50)).toEqual({ processed: 0, errors: 0 });
  });
});
