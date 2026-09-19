/**
 * The video-poster re-arm sweep.
 *
 * Before poster extraction existed, every video was terminally skipped by the
 * thumb, preview, describe and face stages — and a skip writes the stage's
 * target version, so all of them consider every existing video permanently
 * handled. Teaching the pipeline to extract poster frames therefore changes
 * nothing on its own; this migration is what makes those rows claimable again.
 *
 * Three things are worth failing over. The reset is all five fields, so a video
 * whose thumb stage dead-lettered is genuinely re-claimable. The exif stage is
 * left alone, because video EXIF belongs to `backfill-video-exif` and re-running
 * it here would undo that migration's work. And with no runnable ffmpeg the
 * sweep does nothing at all rather than stamping a marker the operator cannot
 * clear.
 */

import { describe, it, expect, beforeAll, afterAll, spyOn } from 'bun:test';
import * as videoPosterModule from '../../thumbs/video-poster.ts';
import { classifyMediaType } from '../../indexer/media-types.ts';
import { rearmVideoPosters, VIDEO_POSTER_REARM_VERSION } from './rearm-video-posters.ts';
import {
  assetRow,
  createLibrary,
  seedAsset,
  seedLocation,
  stageRow,
  type MigrationLibrary,
} from './migration.test-helpers.ts';

/** Every stage an existing video is currently sitting "done" in. */
const SEEDED_STAGES = [
  'exif',
  'thumb',
  'preview',
  'describe',
  'face-detect',
  'face-embed',
  'cf-thumb-sync',
] as const;

/** The stages this migration re-arms — every one except exif. */
const REARMED = SEEDED_STAGES.filter((stage) => stage !== 'exif');

function seedMedia(
  library: MigrationLibrary,
  filename: string,
  options: { rearmed?: boolean; deleted?: boolean; missing?: boolean } = {},
): string {
  const id = seedAsset(library.db, {
    mediaKind: classifyMediaType(filename),
    stages: SEEDED_STAGES,
    videoPosterRearmVersion: options.rearmed ? VIDEO_POSTER_REARM_VERSION : null,
  });
  seedLocation(library.db, {
    assetId: id,
    libraryId: library.folderId,
    path: 'media',
    filename,
    deletedAt: options.deleted ? '2026-01-01T00:00:00.000Z' : null,
    missingSince: options.missing ? '2026-01-01T00:00:00.000Z' : null,
  });
  // Every seeded stage is "already processed"; thumb is the one the assertions
  // read, so it gets a distinct version from exif's.
  library.db.run(`UPDATE stage_state SET version = 1 WHERE asset_id = ?`, [id]);
  library.db.run(`UPDATE stage_state SET version = 3 WHERE asset_id = ? AND stage = 'thumb'`, [id]);
  return id;
}

describe('rearmVideoPosters — selection', () => {
  it('counts videos that have not been re-armed, and ignores stills', async () => {
    using library = await createLibrary('maple-poster-');
    seedMedia(library, 'IMG_1.MOV');
    seedMedia(library, 'clip.mp4');
    seedMedia(library, 'photo.dng');
    seedMedia(library, 'scan.jpg');

    expect(await rearmVideoPosters.countRemaining()).toBe(2);
  });

  it('excludes videos already stamped at the current re-arm version', async () => {
    using library = await createLibrary('maple-poster-');
    seedMedia(library, 'done.mov', { rearmed: true });
    seedMedia(library, 'todo.mov');

    expect(await rearmVideoPosters.countRemaining()).toBe(1);
  });

  it('excludes soft-deleted and missing video locations', async () => {
    using library = await createLibrary('maple-poster-');
    seedMedia(library, 'gone.mov', { deleted: true });
    seedMedia(library, 'vanished.mov', { missing: true });

    expect(await rearmVideoPosters.countRemaining()).toBe(0);
  });

  it('matches video extensions case-insensitively', async () => {
    using library = await createLibrary('maple-poster-');
    seedMedia(library, 'UPPER.MOV');
    seedMedia(library, 'lower.mkv');

    expect(await rearmVideoPosters.countRemaining()).toBe(2);
  });
});

/**
 * `runBatch` refuses to act without a decoder, so every test that exercises the
 * actual re-arm pins ffmpeg as present — pinned rather than read from the host,
 * so these assert the same thing on a dev Mac and on CI.
 */
describe('rearmVideoPosters — runBatch', () => {
  let ffmpegSpy: ReturnType<typeof spyOn>;
  beforeAll(() => {
    ffmpegSpy = spyOn(videoPosterModule, 'ffmpegBinary').mockResolvedValue('/usr/bin/ffmpeg');
  });
  afterAll(() => {
    ffmpegSpy.mockRestore();
  });

  it('resets every poster-dependent stage to unprocessed and stamps the marker', async () => {
    using library = await createLibrary('maple-poster-');
    const id = seedMedia(library, 'IMG_9.MOV');

    expect(await rearmVideoPosters.runBatch(50)).toEqual({ processed: 1, errors: 0 });

    for (const stage of REARMED) {
      expect(stageRow(library.db, id, stage)!.version).toBe(0);
    }
    expect(assetRow(library.db, id)!.video_poster_rearm_version).toBe(VIDEO_POSTER_REARM_VERSION);
  });

  it('clears attempts / last_error / dead, not just the version', async () => {
    using library = await createLibrary('maple-poster-');
    // A video whose thumb stage previously dead-lettered. Resetting the version
    // alone leaves it parked, and the claim query would never hand this asset
    // to the stage again — it would silently never get a poster.
    const id = seedMedia(library, 'dead.mov');
    library.db.run(
      `UPDATE stage_state
          SET attempts = 5, last_error = 'no still frame to thumbnail', dead = 1,
              processed_at = '2026-01-01T00:00:00.000Z'
        WHERE asset_id = ? AND stage = 'thumb'`,
      [id],
    );

    await rearmVideoPosters.runBatch(50);

    expect(stageRow(library.db, id, 'thumb')).toEqual({
      version: 0,
      attempts: 0,
      last_error: null,
      dead: 0,
    });
  });

  it('leaves the exif stage untouched', async () => {
    using library = await createLibrary('maple-poster-');
    const id = seedMedia(library, 'has-exif.mov');

    await rearmVideoPosters.runBatch(50);

    // Video EXIF is owned by backfill-video-exif (#1525). Resetting it here
    // would re-run that migration's work and could re-file the asset.
    expect(stageRow(library.db, id, 'exif')!.version).toBe(1);
  });

  it('does not touch stills', async () => {
    using library = await createLibrary('maple-poster-');
    const still = seedMedia(library, 'keep.dng');
    seedMedia(library, 'sweep.mov');

    await rearmVideoPosters.runBatch(50);

    expect(stageRow(library.db, still, 'thumb')!.version).toBe(3);
    expect(assetRow(library.db, still)!.video_poster_rearm_version).toBeNull();
  });

  it('honours batchSize', async () => {
    using library = await createLibrary('maple-poster-');
    seedMedia(library, 'a.mov');
    seedMedia(library, 'b.mov');
    seedMedia(library, 'c.mov');

    expect((await rearmVideoPosters.runBatch(2)).processed).toBe(2);
    expect(await rearmVideoPosters.countRemaining()).toBe(1);
  });

  it('converges: a second pass finds nothing and is a no-op', async () => {
    using library = await createLibrary('maple-poster-');
    const id = seedMedia(library, 'once.mov');

    await rearmVideoPosters.runBatch(50);
    expect(await rearmVideoPosters.countRemaining()).toBe(0);

    // The done-marker is what terminates this. The thumb stage re-stamping the
    // asset after it renders a poster must NOT put it back in the candidate
    // set — without the marker the migration would loop forever, re-arming the
    // very work it just caused.
    library.db.run(`UPDATE stage_state SET version = 3 WHERE asset_id = ? AND stage = 'thumb'`, [
      id,
    ]);
    expect(await rearmVideoPosters.countRemaining()).toBe(0);
    expect(await rearmVideoPosters.runBatch(50)).toEqual({ processed: 0, errors: 0 });
  });
});

/**
 * The no-decoder hold-off. Without it this migration has a dead end: re-arming
 * while ffmpeg is absent stamps the marker on every asset AND lets thumb and
 * preview immediately re-skip them with `no-video-decoder`, after which the
 * remaining count reads zero and re-running does nothing — the operator cannot
 * recover without bumping the constant or editing the database by hand.
 */
describe('rearmVideoPosters — no ffmpeg on the host', () => {
  it('does nothing and leaves the backlog intact and visible', async () => {
    using library = await createLibrary('maple-poster-');
    const ffmpegSpy = spyOn(videoPosterModule, 'ffmpegBinary').mockResolvedValue(null);
    try {
      const ids = [seedMedia(library, 'hold-a.mov'), seedMedia(library, 'hold-b.mov')];

      expect(await rearmVideoPosters.runBatch(50)).toEqual({ processed: 0, errors: 0 });

      // Nothing stamped — the marker is what would strand these.
      for (const id of ids) {
        expect(assetRow(library.db, id)!.video_poster_rearm_version).toBeNull();
        expect(stageRow(library.db, id, 'thumb')!.version).toBe(3);
      }
      // Still counted as outstanding, so Settings → Workers shows real work
      // pending rather than a silently "finished" migration.
      expect(await rearmVideoPosters.countRemaining()).toBe(2);
    } finally {
      ffmpegSpy.mockRestore();
    }
  });

  it('picks the work up on a later tick once ffmpeg appears, with no restart', async () => {
    using library = await createLibrary('maple-poster-');
    const id = seedMedia(library, 'later.mov');

    const absent = spyOn(videoPosterModule, 'ffmpegBinary').mockResolvedValue(null);
    try {
      expect((await rearmVideoPosters.runBatch(50)).processed).toBe(0);
    } finally {
      absent.mockRestore();
    }

    const present = spyOn(videoPosterModule, 'ffmpegBinary').mockResolvedValue('/usr/bin/ffmpeg');
    try {
      expect((await rearmVideoPosters.runBatch(50)).processed).toBe(1);
      expect(stageRow(library.db, id, 'thumb')!.version).toBe(0);
    } finally {
      present.mockRestore();
    }
  });
});
