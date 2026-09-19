/**
 * Parity with the Mongo repository, checked two ways.
 *
 * **By value.** The same asset is built twice — once as the BSON document the
 * Mongo transform consumes, once as the rows the SQLite queries return — and
 * the two DTOs are compared after a JSON round trip, which is exactly what a
 * client sees. A field that moved to a side table, a boolean that became a 0/1
 * column or an array that became rows would all show up here.
 *
 * **By type.** The `Exact<>` assertions below fail to compile when a ported
 * function's parameter or return type drifts from the Mongo one. They are
 * cheap, they run on every build rather than on every test run, and they are
 * the reason the port can claim "unchanged signature" rather than assert it.
 */

import { describe, expect, test } from 'bun:test';
import { ObjectId } from '../object-id.ts';
import {
  toCoreInfo as mongoToCoreInfo,
  toDetailDto as mongoToDetailDto,
  toListItemDto as mongoToListItemDto,
} from '../assets.transform.ts';
import type { AssetWithId } from '../schema.ts';
import type * as MongoRepo from '../assets.repo.ts';
import * as SqliteRepo from './assets.repo.ts';
import { deleteOutcome, updateOutcome } from './db-handle.ts';
import { insertDetail, insertFaceRow, insertPersonRow } from './assets.test-helpers.ts';
import {
  createTestDatabase,
  insertAsset,
  insertFolder,
  insertLocation,
  run,
  testSqliteDb,
} from '../sqlite/test-sqlite.test-helpers.ts';

/** `true` only when the two types are mutually assignable. */
type Exact<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;

/** The first parameter of a function type. */
type Head<F> = F extends (first: infer A, ...rest: readonly never[]) => unknown ? A : never;

const LIBRARY_ROOT = '/libraries/main';
const ASSET_ID = '0123456789abcdef01234567';
const LIBRARY_ID = '76543210fedcba9876543210';
const PERSON_ID = 'aaaaaaaaaaaaaaaaaaaaaaaa';
const CAPTURED_AT = '2026-04-01T10:00:00Z';
const INDEXED_AT = '2026-04-01T12:00:00Z';

const EXIF = { captured_at: CAPTURED_AT, captured_month: 4, iso: 200, camera_make: 'Hasselblad' };
const PLACE = {
  source: 'nominatim' as const,
  geocoder_version: 3,
  geocoded_at: '2026-04-01T13:00:00Z',
  lat: 40.7,
  lon: -73.9,
  display_name: 'Brooklyn, New York',
  address: { city: 'New York', country_code: 'us' },
  pois: [],
  rollups: { locality: 'Brooklyn', region: 'New York', country_code: 'us' },
  search_blob: 'brooklyn new york',
};
const VISION = { scene_type: 'outdoor', activity: 'sailing' };
const TRANSCRIPT = {
  text: 'hello there',
  language: 'en',
  model: 'whisper-1',
  duration_sec: 3,
  generated_at: '2026-04-01T14:00:00Z',
  segments: [{ start: 0, end: 3, text: 'hello there' }],
};

/** The document the Mongo transform would be handed for this asset. */
function mongoDocument(): AssetWithId {
  return {
    _id: new ObjectId(ASSET_ID),
    fileinfo: [
      {
        path: 'vacation/2024',
        filename: 'IMG_1.dng',
        library_id: new ObjectId(LIBRARY_ID),
        deleted_at: null,
      },
    ],
    size: 2048,
    mtime: 1_700_000_000_123,
    rating: 4,
    flag: 1,
    color_label: 'red',
    has_xmp: true,
    sidecar_ver: 3,
    hidden: false,
    hidden_reason: null,
    hidden_ack: false,
    is_screenshot: true,
    indexed_at: INDEXED_AT,
    exif: EXIF,
    place: PLACE,
    maple_id: 'content-1',
    deleted_at: null,
    original_path: null,
    description: 'a boat',
    description_meta: { model: 'qwen' },
    ocr_text: 'SEA',
    ocr_meta: { model: 'qwen', generated_at: '2026-04-01T15:00:00Z' },
    vision: VISION,
    vision_meta: { model: 'qwen', prompt_version: 7, generated_at: '2026-04-01T15:00:00Z' },
    transcript: TRANSCRIPT,
    faces: [
      {
        bbox: { x: 0.1, y: 0.2, w: 0.3, h: 0.4 },
        person_id: PERSON_ID,
        confidence: 0.91,
        embedding_version: 'arcface_r100_glint360k_v1',
      },
    ],
    enrichment: {
      geocode: {
        done_at: '2026-04-01T13:00:00Z',
        locked_by: null,
        lease_expires_at: null,
        attempts: 0,
        last_error: null,
        version: 2,
        dead_letter_at: null,
      },
      face: {
        done_at: null,
        locked_by: 'worker-1',
        lease_expires_at: '2026-04-01T16:00:00Z',
        attempts: 1,
        last_error: 'timeout',
        version: null,
        dead_letter_at: null,
      },
      describe: {
        done_at: null,
        locked_by: null,
        lease_expires_at: null,
        attempts: 0,
        last_error: null,
        version: null,
        dead_letter_at: null,
      },
    },
  } as unknown as AssetWithId;
}

/** The same asset, written as rows. */
function seedRows(db: Parameters<typeof insertAsset>[0]): void {
  insertFolder(db, { path: LIBRARY_ROOT, slug: 'main' });
  run(db, `UPDATE folders SET id = ? WHERE path = ?`, LIBRARY_ID, LIBRARY_ROOT);
  insertAsset(db, { id: ASSET_ID, exif: JSON.stringify(EXIF), place: JSON.stringify(PLACE) });
  run(
    db,
    `UPDATE assets SET size = 2048, mtime = 1700000000123, rating = 4, flag = 1,
       color_label = 'red', has_xmp = 1, sidecar_ver = 3, is_screenshot = 1,
       indexed_at = ?, maple_id = 'content-1'
     WHERE id = ?`,
    INDEXED_AT,
    ASSET_ID,
  );
  insertLocation(db, {
    assetId: ASSET_ID,
    libraryId: LIBRARY_ID,
    path: 'vacation/2024',
    filename: 'IMG_1.dng',
  });
  insertDetail(db, ASSET_ID, {
    description: 'a boat',
    descriptionMeta: JSON.stringify({ model: 'qwen' }),
    ocrText: 'SEA',
    ocrMeta: JSON.stringify({ model: 'qwen', generated_at: '2026-04-01T15:00:00Z' }),
    vision: JSON.stringify(VISION),
    visionMeta: JSON.stringify({
      model: 'qwen',
      prompt_version: 7,
      generated_at: '2026-04-01T15:00:00Z',
    }),
    transcript: JSON.stringify(TRANSCRIPT),
  });
  insertPersonRow(db, 'Maya', PERSON_ID);
  insertFaceRow(db, {
    assetId: ASSET_ID,
    personId: PERSON_ID,
    confidence: 0.91,
    embeddingVersion: 'arcface_r100_glint360k_v1',
  });
  run(
    db,
    `INSERT INTO enrichment_state (asset_id, stage, done_at, version) VALUES (?, 'geocode', ?, 2)`,
    ASSET_ID,
    '2026-04-01T13:00:00Z',
  );
  run(
    db,
    `INSERT INTO enrichment_state (asset_id, stage, locked_by, lease_expires_at, attempts, last_error)
     VALUES (?, 'face', 'worker-1', ?, 1, 'timeout')`,
    ASSET_ID,
    '2026-04-01T16:00:00Z',
  );
}

const LIBRARIES = new Map([[LIBRARY_ID, LIBRARY_ROOT]]);
const PERSON_NAMES = new Map([[PERSON_ID, 'Maya']]);

/** What a client actually receives: no ObjectIds, no undefined-valued keys. */
function wire(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value));
}

describe('DTO parity with the Mongo transform', () => {
  test('the detail DTO is byte-identical on the wire', async () => {
    using handle = await createTestDatabase();
    seedRows(handle.db);

    const expected = mongoToDetailDto(mongoDocument(), LIBRARIES, PERSON_NAMES);
    const actual = await SqliteRepo.findDetailById(new ObjectId(ASSET_ID), testSqliteDb(handle.db));

    expect(wire(actual)).toEqual(wire(expected));
  });

  test('the list-item DTO is byte-identical on the wire', async () => {
    using handle = await createTestDatabase();
    seedRows(handle.db);

    const expected = mongoToListItemDto(mongoDocument(), LIBRARIES);
    const [actual] = await SqliteRepo.findListItems({}, 10, testSqliteDb(handle.db));

    expect(wire(actual)).toEqual(wire(expected));
  });

  test('the core-info shape matches, ObjectId for ObjectId', async () => {
    using handle = await createTestDatabase();
    seedRows(handle.db);

    const expected = mongoToCoreInfo(mongoDocument(), LIBRARIES);
    const actual = await SqliteRepo.findCoreInfoById(
      new ObjectId(ASSET_ID),
      testSqliteDb(handle.db),
    );

    expect(actual!.id.toHexString()).toBe(expected.id.toHexString());
    expect(actual!.folder_id?.toHexString()).toBe(expected.folder_id?.toHexString());
    expect(wire(actual)).toEqual(wire(expected));
  });
});

describe('signature parity with the Mongo repository', () => {
  test('every ported read returns the Mongo return type exactly', () => {
    const detail: Exact<
      Awaited<ReturnType<typeof MongoRepo.findDetailById>>,
      Awaited<ReturnType<typeof SqliteRepo.findDetailById>>
    > = true;
    const details: Exact<
      Awaited<ReturnType<typeof MongoRepo.findDetailsByIds>>,
      Awaited<ReturnType<typeof SqliteRepo.findDetailsByIds>>
    > = true;
    const byAddress: Exact<
      Awaited<ReturnType<typeof MongoRepo.findDetailByAddress>>,
      Awaited<ReturnType<typeof SqliteRepo.findDetailByAddress>>
    > = true;
    const core: Exact<
      Awaited<ReturnType<typeof MongoRepo.findCoreInfoById>>,
      Awaited<ReturnType<typeof SqliteRepo.findCoreInfoById>>
    > = true;
    const list: Exact<
      Awaited<ReturnType<typeof MongoRepo.findListItems>>,
      Awaited<ReturnType<typeof SqliteRepo.findListItems>>
    > = true;
    const requeue: Exact<
      Awaited<ReturnType<typeof MongoRepo.requeueEnrichmentStage>>,
      Awaited<ReturnType<typeof SqliteRepo.requeueEnrichmentStage>>
    > = true;
    const parse: Exact<
      ReturnType<typeof MongoRepo.parseAssetId>,
      ReturnType<typeof SqliteRepo.parseAssetId>
    > = true;
    expect([detail, details, byAddress, core, list, requeue, parse]).toEqual([
      true,
      true,
      true,
      true,
      true,
      true,
      true,
    ]);
  });

  test('every ported function takes the same first parameter', () => {
    const detail: Exact<
      Head<typeof MongoRepo.findDetailById>,
      Head<typeof SqliteRepo.findDetailById>
    > = true;
    const list: Exact<
      Head<typeof MongoRepo.findListItems>,
      Head<typeof SqliteRepo.findListItems>
    > = true;
    const filter: Exact<MongoRepo.ListFilter, SqliteRepo.ListFilter> = true;
    const hasXmp: Exact<Head<typeof MongoRepo.setHasXmp>, Head<typeof SqliteRepo.setHasXmp>> = true;
    const place: Exact<
      Head<typeof MongoRepo.setPlaceOverride>,
      Head<typeof SqliteRepo.setPlaceOverride>
    > = true;
    const trash: Exact<
      Head<typeof MongoRepo.hardDelete>,
      Head<typeof SqliteRepo.hardDelete>
    > = true;
    expect([detail, list, filter, hasXmp, place, trash]).toEqual([
      true,
      true,
      true,
      true,
      true,
      true,
    ]);
  });

  test('write outcomes report the counts their callers branch on', () => {
    // `UpdateOutcome`/`DeleteOutcome` (db-handle.ts) are Maple's own shapes
    // now — the field names are the ones the routes were written against, and
    // nothing external defines them any more, so every field is pinned here by
    // value rather than by a type annotation.
    //
    // What each one means to a caller: `matchedCount` is how many rows the
    // statement found, and `=== 0` is the only test any route makes ("no such
    // asset" → 404). `modifiedCount` always equals it, because SQLite's
    // `changes()` counts a row it rewrote with an identical value. `upsertedId`
    // and `upsertedCount` are always null/0: nothing here upserts through a
    // filter. `acknowledged` is always true — a failed write throws.
    expect(updateOutcome(1)).toEqual({
      acknowledged: true,
      matchedCount: 1,
      modifiedCount: 1,
      upsertedCount: 0,
      upsertedId: null,
    });
    expect(updateOutcome(0)).toEqual({
      acknowledged: true,
      matchedCount: 0,
      modifiedCount: 0,
      upsertedCount: 0,
      upsertedId: null,
    });
    expect(deleteOutcome(2)).toEqual({ acknowledged: true, deletedCount: 2 });
    expect(deleteOutcome(0)).toEqual({ acknowledged: true, deletedCount: 0 });
  });
});
