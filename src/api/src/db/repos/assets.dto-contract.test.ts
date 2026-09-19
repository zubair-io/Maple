/**
 * The DTO contract: what a client actually receives for one asset.
 *
 * Three shapes go out of this repository — the full detail DTO behind
 * `GET /api/assets/:id`, the working-set item behind `GET /api/assets`, and the
 * internal `AssetCoreInfo` the filesystem and change-feed routes pass around.
 * Each case below seeds one asset's rows, reads a shape back, and states its
 * expected content outright, after the JSON round trip a real response goes
 * through. A field that changed type, changed unit, or flipped between `null`
 * and absent fails here rather than in a client.
 *
 * This began as a parity suite: the same asset was built twice, once as the
 * MongoDB document the old transform consumed and once as rows, and the two
 * DTOs compared. With the document side gone there is nothing left to compare
 * against, and a comparison was never the point — the point was the shape the
 * client sees. Each subtlety the comparison happened to pin is now named at the
 * case that pins it.
 */

import { describe, expect, test } from 'bun:test';
import { ObjectId } from '../object-id.ts';
import * as SqliteRepo from './assets.repo.ts';
import type { AssetCoreInfo, AssetDetailDto, AssetListItemDto } from '../assets.transform.ts';
import {
  deleteOutcome,
  updateOutcome,
  type DeleteOutcome,
  type UpdateOutcome,
} from './db-handle.ts';
import { insertDetail, insertFaceRow, insertPersonRow } from './assets.test-helpers.ts';
import {
  createTestDatabase,
  insertAsset,
  insertFolder,
  insertLocation,
  run,
  testSqliteDb,
} from '../sqlite/test-sqlite.test-helpers.ts';

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
const VISION_META = { model: 'qwen', prompt_version: 7, generated_at: '2026-04-01T15:00:00Z' };
const OCR_META = { model: 'qwen', generated_at: '2026-04-01T15:00:00Z' };
const TRANSCRIPT = {
  text: 'hello there',
  language: 'en',
  model: 'whisper-1',
  duration_sec: 3,
  generated_at: '2026-04-01T14:00:00Z',
  segments: [{ start: 0, end: 3, text: 'hello there' }],
};

/** One asset with one location, one named face, and every payload populated. */
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
    ocrMeta: JSON.stringify(OCR_META),
    vision: JSON.stringify(VISION),
    visionMeta: JSON.stringify(VISION_META),
    transcript: JSON.stringify(TRANSCRIPT),
  });
  insertPersonRow(db, 'Maya', PERSON_ID);
  insertFaceRow(db, {
    assetId: ASSET_ID,
    personId: PERSON_ID,
    confidence: 0.91,
    embeddingVersion: 'arcface_r100_glint360k_v1',
  });
  // Only two of the three enrichment stages have a row. The third is the point
  // of the `enrichment` assertion below.
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

/**
 * The asset's single location, as both list-carrying DTOs rebuild it from the
 * `asset_locations` row.
 *
 * `deleted_at: null` is present rather than absent, deliberately: every writer
 * that creates a location writes the field explicitly, so a client that reads
 * the key finds it. `missing_since`, `missing_reason` and `keep` are absent,
 * because nothing set them and absent is what they meant.
 */
const FILEINFO_WIRE = [
  {
    path: 'vacation/2024',
    filename: 'IMG_1.dng',
    library_id: LIBRARY_ID,
    deleted_at: null,
  },
];

/** What a client actually receives: no ObjectIds, no undefined-valued keys. */
function wire(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value));
}

/** `true` only when the two types are mutually assignable. */
type Exact<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;

describe('the detail DTO returned by GET /api/assets/:id', () => {
  test('carries every field a client reads, with the right types', async () => {
    using handle = await createTestDatabase();
    seedRows(handle.db);

    const actual = await SqliteRepo.findDetailById(new ObjectId(ASSET_ID), testSqliteDb(handle.db));

    expect(wire(actual)).toEqual({
      id: ASSET_ID,
      // Hex strings on the wire; `abs_path` is composed from the library root
      // plus the location's directory and filename.
      folder_id: LIBRARY_ID,
      filename: 'IMG_1.dng',
      abs_path: '/libraries/main/vacation/2024/IMG_1.dng',
      fileinfo: FILEINFO_WIRE,
      size: 2048,
      // Epoch MILLISECONDS here. The list item below reports seconds.
      mtime: 1_700_000_000_123,
      rating: 4,
      sidecar_ver: 3,
      flag: 1,
      color_label: 'red',
      indexed_at: INDEXED_AT,
      // Stored JSON payloads reach the client verbatim.
      place: PLACE,
      // The face's `person_id` is resolved to a display name by the join; a
      // face whose person has no name, or none assigned, reports `name: null`.
      faces: [
        {
          bbox: { x: 0.1, y: 0.2, w: 0.3, h: 0.4 },
          person_id: PERSON_ID,
          confidence: 0.91,
          name: 'Maya',
          embedding_version: 'arcface_r100_glint360k_v1',
        },
      ],
      description: 'a boat',
      description_meta: { model: 'qwen' },
      ocr_text: 'SEA',
      ocr_meta: OCR_META,
      vision: VISION,
      vision_meta: VISION_META,
      // Tri-state: `true`/`false` once the classifier has looked at the asset,
      // `null` while it has not — which is a different claim from "not a
      // screenshot" and is why this field goes through `nullableBool`. All
      // three states are exercised in `assets.repo.test.ts`.
      is_screenshot: true,
      // The stored transcript's per-segment timing array is dropped: the info
      // pane renders `text` as one block.
      transcript: {
        text: 'hello there',
        language: 'en',
        model: 'whisper-1',
        duration_sec: 3,
        generated_at: '2026-04-01T14:00:00Z',
      },
      video_description: null,
      video_description_meta: null,
      // Always present, never absent. Both are NOT NULL 0/1 columns, so an
      // asset that never set them reports `false` where the document store
      // omitted the key entirely. Every consumer treats the two alike.
      hidden: false,
      hidden_reason: null,
      hidden_ack: false,
      // All three stages appear even though only two have a row: a stage with
      // no state is normalised to the same pending shape a freshly created
      // asset had, so a client never has to handle a missing stage.
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
    });
    // `xmp_mtime` / `xmp_size` are attached by the metadata routes after a
    // stat, so a DTO built straight from the database carries neither key. The
    // exact match above already pins that; these say why.
    expect(actual).not.toHaveProperty('xmp_mtime');
    expect(actual).not.toHaveProperty('xmp_size');
  });
});

describe('the working-set item returned by GET /api/assets', () => {
  test('is the narrow projection, with mtime in seconds', async () => {
    using handle = await createTestDatabase();
    seedRows(handle.db);

    const [actual] = await SqliteRepo.findListItems({}, 10, testSqliteDb(handle.db));

    // The exact match is the point: this endpoint pages a thousand rows at a
    // time, and the vision, transcript and face payloads the detail DTO
    // carries would dominate the response if one leaked in here.
    expect(wire(actual)).toEqual({
      id: ASSET_ID,
      folder_id: LIBRARY_ID,
      filename: 'IMG_1.dng',
      abs_path: '/libraries/main/vacation/2024/IMG_1.dng',
      fileinfo: FILEINFO_WIRE,
      // Epoch SECONDS, not milliseconds: the Swift File Provider decodes this
      // through `Date(timeIntervalSince1970:)`. The stored value is
      // 1_700_000_000_123 ms — the same asset's detail DTO reports it in full.
      mtime: 1_700_000_000,
      rating: 4,
      has_xmp: true,
      hidden: false,
      hidden_reason: null,
      hidden_ack: false,
    });
  });
});

describe('the core-info shape the FS and change-feed routes pass around', () => {
  test('keeps its two ids as ObjectIds and carries the trash fields', async () => {
    using handle = await createTestDatabase();
    seedRows(handle.db);

    const actual = await SqliteRepo.findCoreInfoById(
      new ObjectId(ASSET_ID),
      testSqliteDb(handle.db),
    );

    // This shape is internal, and its callers hand `id` and `folder_id`
    // straight back to another repository call — so unlike the two wire DTOs
    // above, they stay ObjectIds rather than becoming hex strings.
    expect(actual!.id).toBeInstanceOf(ObjectId);
    expect(actual!.id.toHexString()).toBe(ASSET_ID);
    expect(actual!.folder_id).toBeInstanceOf(ObjectId);
    expect(actual!.folder_id!.toHexString()).toBe(LIBRARY_ID);

    expect(wire(actual)).toEqual({
      id: ASSET_ID,
      folder_id: LIBRARY_ID,
      filename: 'IMG_1.dng',
      abs_path: '/libraries/main/vacation/2024/IMG_1.dng',
      fileinfo: FILEINFO_WIRE,
      size: 2048,
      mtime: 1_700_000_000_123,
      maple_id: 'content-1',
      // The three trash fields. `deleted_reason: 'reaped'` is the one value
      // that matters — it means the missing-reaper soft-deleted the row and no
      // trashed copy exists on disk, so restore and purge must not touch it.
      // Anything else reads as `null`, which is what an ordinary asset has.
      deleted_at: null,
      deleted_reason: null,
      original_path: null,
      place: PLACE,
      description: 'a boat',
      ocr_text: 'SEA',
      exif: EXIF,
    });
  });
});

describe('the shapes the repository is declared to return', () => {
  test('every read answers a declared DTO; every write answers an outcome', () => {
    // The other half of the contract. The cases above pin what a DTO
    // *contains*; these pin that the repository functions are typed to return
    // the declarations in `db/assets.transform.ts` and `db-handle.ts` rather
    // than some structural look-alike that happens to match today. A read that
    // widened to `any`, or a write that started answering a bare row count,
    // stops compiling here instead of reaching a route.
    //
    // They cost nothing at run time — the assignments below either compile or
    // they do not — which is why they run on every build rather than only when
    // someone executes this file.
    const detail: Exact<
      Awaited<ReturnType<typeof SqliteRepo.findDetailById>>,
      AssetDetailDto | null
    > = true;
    const details: Exact<
      Awaited<ReturnType<typeof SqliteRepo.findDetailsByIds>>,
      AssetDetailDto[]
    > = true;
    const byAddress: Exact<
      Awaited<ReturnType<typeof SqliteRepo.findDetailByAddress>>,
      AssetDetailDto | null
    > = true;
    const core: Exact<
      Awaited<ReturnType<typeof SqliteRepo.findCoreInfoById>>,
      AssetCoreInfo | null
    > = true;
    const list: Exact<
      Awaited<ReturnType<typeof SqliteRepo.findListItems>>,
      AssetListItemDto[]
    > = true;
    const parse: Exact<ReturnType<typeof SqliteRepo.parseAssetId>, ObjectId | null> = true;
    const hasXmp: Exact<Awaited<ReturnType<typeof SqliteRepo.setHasXmp>>, UpdateOutcome> = true;
    const place: Exact<
      Awaited<ReturnType<typeof SqliteRepo.setPlaceOverride>>,
      UpdateOutcome
    > = true;
    const trash: Exact<Awaited<ReturnType<typeof SqliteRepo.hardDelete>>, DeleteOutcome> = true;
    // The one write that is not an outcome: requeueing an enrichment stage
    // answers the version it bumped the stage to, or `null` when there was no
    // such asset. The route turns that into the requeued version it reports.
    const requeue: Exact<
      Awaited<ReturnType<typeof SqliteRepo.requeueEnrichmentStage>>,
      { version: number } | null
    > = true;
    expect([detail, details, byAddress, core, list, parse]).toEqual([
      true,
      true,
      true,
      true,
      true,
      true,
    ]);
    expect([hasXmp, place, trash, requeue]).toEqual([true, true, true, true]);
  });
});

describe('what a write reports back', () => {
  test('the outcome shapes carry the counts their callers branch on', () => {
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
