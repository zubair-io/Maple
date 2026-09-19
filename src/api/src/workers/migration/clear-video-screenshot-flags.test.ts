/**
 * The screenshot-flag clearing sweep.
 *
 * `is_screenshot` is a stills-only concept (#2325), but a video could acquire
 * it in two places — the column, from the filename heuristic, and the describe
 * stage's stored verdict, from a poster frame that looked like a UI. A flagged
 * video drops out of the Photos bucket of the Photos/Screenshots filter, and
 * the describe prompt's short-circuit also nulled its whole scene description.
 *
 * Two rules carry the weight here. The re-arm is the full five-field reset, not
 * a version bump, or a row that had dead-lettered would stay parked and never
 * be claimed again. And the sweep must never fabricate a describe payload on a
 * video the stage has not run — a caption-less one would satisfy the "vision
 * exists" branch in `sidecar-metadata-index` and permanently shadow the
 * filename heuristic for that asset.
 */

import { describe, it, expect } from 'bun:test';
import {
  clearVideoScreenshotFlags,
  VIDEO_SCREENSHOT_CLEAR_VERSION,
} from './clear-video-screenshot-flags.ts';
import {
  assetRow,
  createLibrary,
  parkStage,
  seedAsset,
  seedLocation,
  stageRow,
  visionScreenshot,
  type MigrationLibrary,
  type SeedAsset,
} from './migration.test-helpers.ts';

const REARMED = ['describe', 'meili'] as const;

/** Every fixture needs its own filename: a location is UNIQUE per library and path. */
let seq = 0;

function seedVideo(library: MigrationLibrary, overrides: Partial<SeedAsset> = {}): string {
  const n = ++seq;
  const id = seedAsset(library.db, {
    mapleId: `clear-video-${n}`,
    mediaKind: 'video',
    isScreenshot: true,
    stages: REARMED,
    ...overrides,
  });
  seedLocation(library.db, {
    assetId: id,
    libraryId: library.folderId,
    path: '2024/Screenshot',
    filename: `Screen Recording 2024-06-01 (${n}).mov`,
    ...(overrides.location ?? {}),
  });
  for (const stage of REARMED) parkStage(library.db, id, stage);
  return id;
}

function seedStill(library: MigrationLibrary): string {
  const n = ++seq;
  const id = seedAsset(library.db, {
    mapleId: `clear-still-${n}`,
    mediaKind: 'image',
    isScreenshot: true,
    stages: REARMED,
  });
  seedLocation(library.db, {
    assetId: id,
    libraryId: library.folderId,
    path: '2024/Screenshot',
    filename: `Screenshot 2024-06-01 (${n}).png`,
  });
  return id;
}

describe('clear-video-screenshot-flags', () => {
  it('clears the flag on a flagged video and stamps the marker', async () => {
    using library = await createLibrary('maple-clear-shot-');
    const id = seedVideo(library);

    expect(await clearVideoScreenshotFlags.runBatch(100)).toEqual({ processed: 1, errors: 0 });

    const after = assetRow(library.db, id)!;
    expect(after.is_screenshot).toBe(0);
    expect(after.video_screenshot_clear_version).toBe(VIDEO_SCREENSHOT_CLEAR_VERSION);
  });

  it('re-arms describe and meili with the full five-field reset', async () => {
    using library = await createLibrary('maple-clear-shot-');
    const id = seedVideo(library);

    await clearVideoScreenshotFlags.runBatch(100);

    for (const stage of REARMED) {
      const row = stageRow(library.db, id, stage)!;
      expect(row).toEqual({ version: 0, attempts: 0, last_error: null, dead: 0 });
    }
  });

  it('clears the stored verdict when the describe stage has run', async () => {
    using library = await createLibrary('maple-clear-shot-');
    const id = seedVideo(library, {
      vision: { caption: 'a UI', is_screenshot: true, subjects: [] },
    });

    await clearVideoScreenshotFlags.runBatch(100);

    expect(visionScreenshot(library.db, id)).toBe(0);
    // The rest of the payload survives.
    const caption = library.db
      .query(
        `SELECT json_extract(vision, '$.caption') AS caption FROM asset_detail WHERE asset_id = ?`,
      )
      .get(id) as { caption: string };
    expect(caption.caption).toBe('a UI');
  });

  it('selects a video flagged ONLY in the stored verdict', async () => {
    using library = await createLibrary('maple-clear-shot-');
    const id = seedVideo(library, {
      isScreenshot: false,
      vision: { caption: 'a UI', is_screenshot: true, subjects: [] },
    });

    expect(await clearVideoScreenshotFlags.runBatch(100)).toEqual({ processed: 1, errors: 0 });

    expect(visionScreenshot(library.db, id)).toBe(0);
    // The marker and the stage re-arm land in the same transaction as the
    // clear. Split across two writes — as the Mongo version had to be — a
    // failure in between left this row matching neither arm of the candidate
    // predicate on a retry: flag right, stages never re-armed, and silently so.
    expect(assetRow(library.db, id)!.video_screenshot_clear_version).toBe(
      VIDEO_SCREENSHOT_CLEAR_VERSION,
    );
    expect(stageRow(library.db, id, 'describe')!.version).toBe(0);
    expect(stageRow(library.db, id, 'describe')!.dead).toBe(0);
    expect(stageRow(library.db, id, 'meili')!.version).toBe(0);
  });

  it('counts a row carrying BOTH flags exactly once', async () => {
    using library = await createLibrary('maple-clear-shot-');
    const id = seedVideo(library, {
      isScreenshot: true,
      vision: { caption: 'a UI', is_screenshot: true, subjects: [] },
    });

    expect(await clearVideoScreenshotFlags.runBatch(100)).toEqual({ processed: 1, errors: 0 });

    const after = assetRow(library.db, id)!;
    expect(after.is_screenshot).toBe(0);
    expect(visionScreenshot(library.db, id)).toBe(0);
    expect(after.video_screenshot_clear_version).toBe(VIDEO_SCREENSHOT_CLEAR_VERSION);
  });

  it('does NOT fabricate a describe payload on a heuristic-flagged video', async () => {
    using library = await createLibrary('maple-clear-shot-');
    const id = seedVideo(library);

    await clearVideoScreenshotFlags.runBatch(100);

    const detail = library.db
      .query(`SELECT vision FROM asset_detail WHERE asset_id = ?`)
      .get(id) as { vision: string | null } | null;
    expect(detail?.vision ?? null).toBeNull();
  });

  it('leaves still images alone', async () => {
    using library = await createLibrary('maple-clear-shot-');
    const id = seedStill(library);

    await clearVideoScreenshotFlags.runBatch(100);

    const after = assetRow(library.db, id)!;
    expect(after.is_screenshot).toBe(1);
    expect(after.video_screenshot_clear_version).toBeNull();
  });

  it('excludes soft-deleted and missing locations', async () => {
    using library = await createLibrary('maple-clear-shot-');
    const deleted = seedAsset(library.db, {
      mediaKind: 'video',
      isScreenshot: true,
      stages: REARMED,
    });
    seedLocation(library.db, {
      assetId: deleted,
      libraryId: library.folderId,
      filename: 'deleted.mov',
      deletedAt: '2026-01-01T00:00:00.000Z',
    });
    const missing = seedAsset(library.db, {
      mediaKind: 'video',
      isScreenshot: true,
      stages: REARMED,
    });
    seedLocation(library.db, {
      assetId: missing,
      libraryId: library.folderId,
      filename: 'missing.mov',
      missingSince: '2026-01-01T00:00:00.000Z',
    });

    await clearVideoScreenshotFlags.runBatch(100);

    expect(assetRow(library.db, deleted)!.is_screenshot).toBe(1);
    expect(assetRow(library.db, missing)!.is_screenshot).toBe(1);
  });

  it('reaches done and is idempotent on a second pass', async () => {
    using library = await createLibrary('maple-clear-shot-');
    seedVideo(library);

    await clearVideoScreenshotFlags.runBatch(100);
    expect(await clearVideoScreenshotFlags.countRemaining()).toBe(0);
    expect(await clearVideoScreenshotFlags.runBatch(100)).toEqual({ processed: 0, errors: 0 });
  });

  it('countRemaining reports pending work before the sweep', async () => {
    using library = await createLibrary('maple-clear-shot-');
    seedVideo(library);
    seedVideo(library);
    seedStill(library);

    // Two videos pending; the still is not a candidate.
    expect(await clearVideoScreenshotFlags.countRemaining()).toBe(2);
  });
});
