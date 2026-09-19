/**
 * `stage_state.media_kind` — the denormalised narrowing column and the two
 * triggers that own it (#3795).
 *
 * The column exists so a media-only stage's claim can be narrowed by an index
 * instead of by a filter, and the whole value of that depends on it being
 * true. A stale `'image'` on a video asset is not a slow claim, it is a video
 * that is never transcribed and never reported as pending — silence, not an
 * error. So these tests are mostly about the one thing that can go wrong:
 * `media_kind` is derived from an asset's locations and DOES change afterwards,
 * when a photo gains a video location or a backup merge recomputes it.
 *
 * Nothing in the codebase writes this column; the triggers do. That is the same
 * arrangement `assets.live_location_count` has, and for the same reason — a
 * call site that has to remember eventually forgets (#2177).
 */

import { describe, expect, test } from 'bun:test';
import type { Database } from 'bun:sqlite';
import {
  STAGE_STATE_MEDIA_KIND_RECOMPUTE_SQL,
  STAGE_STATE_MEDIA_NARROWING,
  STAGE_STATE_VIDEO_NARROWING,
} from '../sqlite/ddl/stage-state.ts';
import { createTestDatabase, testSqliteDb } from '../sqlite/test-sqlite.test-helpers.ts';
import { claimStageBatch } from './stage-claim.ts';
import { registerStage, seedStageRows } from './stage-state.repo.ts';
import { seedClaimableAsset } from './stage-runtime.test-helpers.ts';

const AV_RESIDUAL = {
  sql: `${STAGE_STATE_MEDIA_NARROWING}
    AND EXISTS (SELECT 1 FROM assets WHERE id = stage_state.asset_id AND media_kind IN (?, ?))`,
  params: ['video', 'audio'] as const,
};
const VIDEO_RESIDUAL = {
  sql: `${STAGE_STATE_VIDEO_NARROWING}
    AND EXISTS (SELECT 1 FROM assets WHERE id = stage_state.asset_id AND media_kind = ?)`,
  params: ['video'] as const,
};

function kindOf(db: Database, assetId: string, stage: string): string | null {
  const row = db
    .query(`SELECT media_kind FROM stage_state WHERE asset_id = ? AND stage = ?`)
    .get(assetId, stage) as { media_kind: string } | null;
  return row?.media_kind ?? null;
}

async function claimedBy(
  db: Database,
  stage: string,
  residual: { sql: string; params: readonly string[] },
): Promise<string[]> {
  const outcome = await claimStageBatch(
    {
      stage,
      targetVersion: 1,
      dependsOn: [],
      residual: { sql: residual.sql, params: residual.params },
      limit: 20,
      maxAttempts: 5,
    },
    testSqliteDb(db),
  );
  return outcome.claimed.map((row) => row.asset_id).sort();
}

describe('the column follows the asset', () => {
  test('a stage row is stamped with the kind the asset has when it is seeded', async () => {
    using handle = await createTestDatabase();
    const video = seedClaimableAsset(handle.db, { mediaKind: 'video', stages: { transcribe: {} } });
    const audio = seedClaimableAsset(handle.db, { mediaKind: 'audio', stages: { transcribe: {} } });
    const image = seedClaimableAsset(handle.db, { mediaKind: 'image', stages: { transcribe: {} } });

    expect(kindOf(handle.db, video, 'transcribe')).toBe('video');
    expect(kindOf(handle.db, audio, 'transcribe')).toBe('audio');
    expect(kindOf(handle.db, image, 'transcribe')).toBe('image');
  });

  test('re-classifying an asset re-stamps every one of its stage rows', async () => {
    using handle = await createTestDatabase();
    const asset = seedClaimableAsset(handle.db, { mediaKind: 'image' });
    await seedStageRows(asset, ['exif', 'thumb', 'transcribe'], testSqliteDb(handle.db));

    handle.db.run(`UPDATE assets SET media_kind = 'video' WHERE id = ?`, [asset]);

    for (const stage of ['exif', 'thumb', 'transcribe']) {
      expect(kindOf(handle.db, asset, stage)).toBe('video');
    }
  });

  test('registering a stage across existing assets stamps the kind too', async () => {
    using handle = await createTestDatabase();
    const video = seedClaimableAsset(handle.db, { mediaKind: 'video' });
    const image = seedClaimableAsset(handle.db, { mediaKind: 'image' });

    // The bulk `INSERT … SELECT` path, which is how an asset that predates a
    // stage becomes eligible for it.
    await registerStage('transcribe', testSqliteDb(handle.db));

    expect(kindOf(handle.db, video, 'transcribe')).toBe('video');
    expect(kindOf(handle.db, image, 'transcribe')).toBe('image');
  });

  test('the recompute repairs the column from assets, both ways', async () => {
    using handle = await createTestDatabase();
    const video = seedClaimableAsset(handle.db, { mediaKind: 'video', stages: { transcribe: {} } });
    const image = seedClaimableAsset(handle.db, { mediaKind: 'image', stages: { transcribe: {} } });
    // What a triggerless bulk load leaves behind, plus the opposite error, so
    // the repair is shown to be a rebuild rather than a one-directional fill.
    handle.db.run(`UPDATE stage_state SET media_kind = 'image' WHERE asset_id = ?`, [video]);
    handle.db.run(`UPDATE stage_state SET media_kind = 'video' WHERE asset_id = ?`, [image]);

    handle.db.exec(STAGE_STATE_MEDIA_KIND_RECOMPUTE_SQL);

    expect(kindOf(handle.db, video, 'transcribe')).toBe('video');
    expect(kindOf(handle.db, image, 'transcribe')).toBe('image');
  });
});

describe('what the narrowed claim then sees', () => {
  test('it claims the media assets and nothing else', async () => {
    using handle = await createTestDatabase();
    const video = seedClaimableAsset(handle.db, { mediaKind: 'video', stages: { transcribe: {} } });
    const audio = seedClaimableAsset(handle.db, { mediaKind: 'audio', stages: { transcribe: {} } });
    seedClaimableAsset(handle.db, { mediaKind: 'image', stages: { transcribe: {} } });

    expect(await claimedBy(handle.db, 'transcribe', AV_RESIDUAL)).toEqual([video, audio].sort());
  });

  test('a video-only stage still leaves the audio assets alone', async () => {
    using handle = await createTestDatabase();
    const video = seedClaimableAsset(handle.db, {
      mediaKind: 'video',
      stages: { 'video-describe': {} },
    });
    seedClaimableAsset(handle.db, { mediaKind: 'audio', stages: { 'video-describe': {} } });
    seedClaimableAsset(handle.db, { mediaKind: 'image', stages: { 'video-describe': {} } });

    expect(await claimedBy(handle.db, 'video-describe', VIDEO_RESIDUAL)).toEqual([video]);
  });

  test('an asset that becomes a video after seeding becomes claimable', async () => {
    using handle = await createTestDatabase();
    const asset = seedClaimableAsset(handle.db, { mediaKind: 'image', stages: { transcribe: {} } });
    expect(await claimedBy(handle.db, 'transcribe', AV_RESIDUAL)).toEqual([]);

    // A photo that gains a video location — `media_kind` is recomputed from the
    // locations, so this is an ordinary thing for it to do. Without the update
    // trigger the row would keep its `'image'` stamp, drop out of the partial
    // index, and this video would never be transcribed, with nothing anywhere
    // saying so.
    handle.db.run(`UPDATE assets SET media_kind = 'video' WHERE id = ?`, [asset]);

    expect(await claimedBy(handle.db, 'transcribe', AV_RESIDUAL)).toEqual([asset]);
  });

  test('an asset that stops being a video drops back out', async () => {
    using handle = await createTestDatabase();
    const asset = seedClaimableAsset(handle.db, { mediaKind: 'video', stages: { transcribe: {} } });

    handle.db.run(`UPDATE assets SET media_kind = 'image' WHERE id = ?`, [asset]);

    expect(await claimedBy(handle.db, 'transcribe', AV_RESIDUAL)).toEqual([]);
  });

  test('the gates still apply to a media asset', async () => {
    using handle = await createTestDatabase();
    // The narrowing is AND-ed in front of the residual, which is itself AND-ed
    // onto the gates — a dead row that matches every media predicate must stay
    // excluded, or the new term has replaced a gate instead of adding one.
    seedClaimableAsset(handle.db, { mediaKind: 'video', stages: { transcribe: { dead: true } } });
    seedClaimableAsset(handle.db, {
      mediaKind: 'video',
      missing: true,
      stages: { transcribe: {} },
    });
    const claimable = seedClaimableAsset(handle.db, {
      mediaKind: 'video',
      stages: { transcribe: {} },
    });

    expect(await claimedBy(handle.db, 'transcribe', AV_RESIDUAL)).toEqual([claimable]);
  });
});
