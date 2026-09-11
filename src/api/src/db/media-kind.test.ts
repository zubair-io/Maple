/**
 * `media_kind` backfill + partial index (#3492), and the property the whole
 * change exists for: video-scoped claim / candidate queries use the small
 * `media_kind_av` index instead of fetching the entire library.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { ObjectId, type Db } from 'mongodb';
import { closeDb, getDb, ensureStageIndexes } from './client.ts';
import { withTestDb } from './test-db.test-helpers.ts';
import { migrationApplied, recordMigration } from './migrations.ts';
import {
  MEDIA_KIND_BACKFILL_ID,
  MEDIA_KIND_INDEX_NAME,
  ensureMediaKind,
  mediaKindExpression,
} from './media-kind.ts';
import { classifyMediaType, mediaKindOfFilenames } from '../indexer/media-types.ts';
import { buildClaimQuery } from '../workers/claim-query.ts';
import videoDescribeStage from '../workers/stages/video-describe.ts';
import transcribeStage from '../workers/stages/transcribe.ts';

withTestDb(`maple_test_media_kind_${process.pid}`);

const sentinel = { applied: migrationApplied, record: recordMigration };

let suiteDb: Db | null = null;
let reachable = true;
beforeAll(async () => {
  try {
    await closeDb();
    suiteDb = await getDb();
  } catch {
    reachable = false;
  }
});
beforeEach(async () => {
  if (!reachable) return;
  const db = await getDb();
  await db.collection('assets').deleteMany({});
  await db.collection('migrations').deleteMany({ _id: MEDIA_KIND_BACKFILL_ID as never });
});
afterAll(async () => {
  if (suiteDb) await suiteDb.dropDatabase();
  await closeDb();
});

const lib = new ObjectId();
function asset(filename: string, extra: Record<string, unknown> = {}) {
  return {
    fileinfo: [{ path: '', filename, library_id: lib, deleted_at: null, missing_since: null }],
    maple_id: new ObjectId().toHexString() + new ObjectId().toHexString(),
    size: 1,
    mtime: 0,
    rating: 0,
    flag: 0,
    color_label: '',
    indexed_at: '2026-01-01T00:00:00Z',
    stages: {},
    ...extra,
  };
}

describe('ensureMediaKind — boot backfill', () => {
  it('derives media_kind from the primary filename exactly like classifyMediaType, once', async () => {
    if (!reachable) return;
    const db = await getDb();
    const names = [
      'IMG_1.dng',
      'clip.MP4',
      'IMG_3113.MOV',
      'voice.m4a',
      'song.MP3',
      'noext',
      'x.webm',
    ];
    await db.collection('assets').insertMany(names.map((n) => asset(n)));
    // A row with no fileinfo at all must not break the pipeline.
    await db.collection('assets').insertOne({ ...asset('ghost.jpg'), fileinfo: [] });
    // A Live Photo backup: still first, video second → video (any location).
    await db.collection('assets').insertOne({
      ...asset('still.HEIC'),
      fileinfo: [
        { path: '', filename: 'still.HEIC', library_id: lib, deleted_at: null },
        { path: '', filename: 'clip.MOV', library_id: lib, deleted_at: null },
      ],
    });

    await ensureMediaKind(db, sentinel);

    for (const n of names) {
      const doc = await db.collection('assets').findOne({ 'fileinfo.0.filename': n });
      expect(doc?.['media_kind']).toBe(classifyMediaType(n));
    }
    expect((await db.collection('assets').findOne({ fileinfo: [] }))?.['media_kind']).toBe('image');
    expect(
      (await db.collection('assets').findOne({ 'fileinfo.1.filename': 'clip.MOV' }))?.[
        'media_kind'
      ],
    ).toBe('video');
    expect(await migrationApplied(db, MEDIA_KIND_BACKFILL_ID)).toBe(true);

    // Sentinel-gated: a later boot does not re-scan. A row inserted without
    // the field afterwards (which no code path does) stays untouched.
    await db.collection('assets').insertOne(asset('later.mov'));
    await ensureMediaKind(db, sentinel);
    expect(
      (await db.collection('assets').findOne({ 'fileinfo.0.filename': 'later.mov' }))?.[
        'media_kind'
      ],
    ).toBeUndefined();
  });

  it('gaining a video location flips an image asset to video (updateLiveLocationCount)', async () => {
    if (!reachable) return;
    const db = await getDb();
    const { updateLiveLocationCount } = await import('../indexer/images.repo.ts');
    const { insertedId } = await db
      .collection('assets')
      .insertOne(asset('still.HEIC', { media_kind: 'image', live_location_count: 1 }));
    await db.collection('assets').updateOne({ _id: insertedId }, {
      $push: { fileinfo: { path: '', filename: 'clip.MOV', library_id: lib, deleted_at: null } },
    } as never);
    await updateLiveLocationCount(db.collection('assets'), insertedId);
    const doc = await db.collection('assets').findOne({ _id: insertedId });
    expect(doc?.['media_kind']).toBe('video');
    expect(doc?.['live_location_count']).toBe(2);
  });

  it('creates the media_kind_av partial index over video + audio rows only', async () => {
    if (!reachable) return;
    const db = await getDb();
    await ensureMediaKind(db, sentinel);
    await ensureMediaKind(db, sentinel); // idempotent
    const idx = (await db.collection('assets').indexes()).find(
      (i) => i.name === MEDIA_KIND_INDEX_NAME,
    );
    expect(idx?.key).toEqual({ media_kind: 1 });
    expect(idx?.partialFilterExpression).toEqual({ media_kind: { $in: ['video', 'audio'] } });
  });

  it('mediaKindExpression is a pure aggregation expression (no JS-side classification)', () => {
    expect(JSON.stringify(mediaKindExpression())).toContain('$regexMatch');
  });

  it('mediaKindOfFilenames is the JS twin: any video wins, then audio, else image', () => {
    expect(mediaKindOfFilenames(['still.HEIC', 'clip.MOV'])).toBe('video');
    expect(mediaKindOfFilenames(['voice.m4a', 'cover.jpg'])).toBe('audio');
    expect(mediaKindOfFilenames(['a.jpg', 'b.dng'])).toBe('image');
    expect(mediaKindOfFilenames([])).toBe('image');
  });
});

describe('video-scoped queries use the media_kind index (#3492)', () => {
  async function seeded() {
    const db = await getDb();
    await db
      .collection('assets')
      .insertMany([
        asset('a.jpg', { media_kind: 'image' }),
        asset('b.dng', { media_kind: 'image' }),
        asset('c.mov', { media_kind: 'video' }),
        asset('d.m4a', { media_kind: 'audio' }),
      ]);
    await ensureMediaKind(db, sentinel);
    await ensureStageIndexes(db);
    return db;
  }
  async function winningPlan(db: Db, filter: Record<string, unknown>): Promise<string> {
    const explain = await db.collection('assets').find(filter).explain('queryPlanner');
    return JSON.stringify(explain.queryPlanner?.winningPlan ?? {});
  }

  it('video-describe and transcribe claim queries hit media_kind_av, never a collection scan', async () => {
    if (!reachable) return;
    const db = await seeded();
    for (const stage of [videoDescribeStage, transcribeStage]) {
      const q = buildClaimQuery(stage.name, stage.targetVersion, [], new Set(), stage.claimFilter);
      const plan = await winningPlan(db, q as Record<string, unknown>);
      expect(plan).not.toContain('COLLSCAN');
      expect(plan).toContain(MEDIA_KIND_INDEX_NAME);
    }
    // And they select exactly the media rows.
    const vd = buildClaimQuery('video-describe', 1, [], new Set(), videoDescribeStage.claimFilter);
    const tr = buildClaimQuery('transcribe', 1, [], new Set(), transcribeStage.claimFilter);
    expect(await db.collection('assets').countDocuments(vd as never)).toBe(1);
    expect(await db.collection('assets').countDocuments(tr as never)).toBe(2);
  });

  it('the shared migration selector hits media_kind_av too', async () => {
    if (!reachable) return;
    const db = await seeded();
    const { liveVideoAssetFilter } = await import('../workers/migration/video-selectors.ts');
    const plan = await winningPlan(db, liveVideoAssetFilter());
    expect(plan).not.toContain('COLLSCAN');
    expect(plan).toContain(MEDIA_KIND_INDEX_NAME);
    expect(await db.collection('assets').countDocuments(liveVideoAssetFilter() as never)).toBe(1);
  });

  it('the migration selector requires the VIDEO location itself to be live (Jules, #3494)', async () => {
    if (!reachable) return;
    const db = await seeded();
    const { liveVideoAssetFilter } = await import('../workers/migration/video-selectors.ts');
    // A Live Photo backup whose .mov was soft-deleted: media_kind stays
    // `video` (a video location exists) and the still is live — but there is
    // no live video to read, so it must not be a candidate.
    await db.collection('assets').insertOne({
      ...asset('still.HEIC', { media_kind: 'video' }),
      fileinfo: [
        { path: '', filename: 'still.HEIC', library_id: lib, deleted_at: null },
        { path: '', filename: 'clip.MOV', library_id: lib, deleted_at: '2026-01-01T00:00:00Z' },
      ],
    });
    // …whereas the same row with the .mov live is one.
    await db.collection('assets').insertOne({
      ...asset('still2.HEIC', { media_kind: 'video' }),
      fileinfo: [
        { path: '', filename: 'still2.HEIC', library_id: lib, deleted_at: null },
        { path: '', filename: 'clip2.MOV', library_id: lib, deleted_at: null },
      ],
    });
    expect(await db.collection('assets').countDocuments(liveVideoAssetFilter() as never)).toBe(2);
    const matched = await db
      .collection('assets')
      .find(liveVideoAssetFilter() as never, { projection: { 'fileinfo.filename': 1 } })
      .toArray();
    const names = matched
      .map((d) => (d['fileinfo'] as Array<{ filename: string }>)[0]!.filename)
      .sort();
    expect(names).toEqual(['c.mov', 'still2.HEIC']);
  });
});
