/**
 * The ported writes.
 *
 * Two things are worth more attention than the rest. The search blob is
 * recomposed from three tables now instead of from one document, so its exact
 * token set is asserted rather than its presence. And every mutation re-arms
 * the stage that depends on what it changed — the mechanism that makes an
 * override eventually consistent with the search index even when the inline
 * Meilisearch call fails.
 */

import { describe, expect, test } from 'bun:test';
import { ObjectId } from 'mongodb';
import {
  clearCfThumbSyncedAt,
  recordSidecarEdit,
  requeueEnrichmentStage,
  setDescriptionOverride,
  setHasXmp,
  setPlaceOverride,
} from './assets.mutations.ts';
import {
  insertDetail,
  insertEnrichmentState,
  insertStageState,
  stageState,
} from './assets.test-helpers.ts';
import {
  createTestDatabase,
  insertAsset,
  insertFolder,
  insertLocation,
  run,
  testSqliteDb,
} from '../test-sqlite.test-helpers.ts';
import type { Place } from '../../schema.ts';

const oid = (hex: string): ObjectId => new ObjectId(hex);

const PLACE: Place = {
  source: 'nominatim',
  geocoder_version: 3,
  geocoded_at: '2026-04-01T13:00:00Z',
  lat: 40.7,
  lon: -73.9,
  display_name: 'Brooklyn, New York',
  address: {},
  pois: [],
  rollups: { locality: 'Brooklyn', region: 'New York', country_code: 'us' },
  search_blob: 'brooklyn new york',
};

function searchBlob(db: Parameters<typeof insertAsset>[0], assetId: string): string | null {
  const row = db.query(`SELECT search_blob FROM asset_search WHERE asset_id = ?`).get(assetId) as {
    search_blob: string;
  } | null;
  return row?.search_blob ?? null;
}

/** An asset with a live location, a caption, OCR text and an April capture. */
function seedAsset(db: Parameters<typeof insertAsset>[0]): string {
  const libraryId = insertFolder(db);
  const assetId = insertAsset(db, {
    exif: JSON.stringify({ captured_at: '2026-04-01T10:00:00Z', captured_month: 4 }),
  });
  insertLocation(db, { assetId, libraryId, filename: 'a.dng' });
  insertDetail(db, assetId, { description: 'a boat', ocrText: 'SEA' });
  insertStageState(db, assetId, 'meili', { version: 5, attempts: 2, dead: true });
  return assetId;
}

describe('setHasXmp', () => {
  test('flips the flag and reports one matched row', async () => {
    using handle = await createTestDatabase();
    const { db } = handle;
    const assetId = insertAsset(db);

    const result = await setHasXmp(oid(assetId), true, testSqliteDb(db));
    expect(result.matchedCount).toBe(1);
    expect(result.acknowledged).toBe(true);
    expect(db.query(`SELECT has_xmp AS v FROM assets WHERE id = ?`).get(assetId)).toEqual({ v: 1 });

    await setHasXmp(oid(assetId), false, testSqliteDb(db));
    expect(db.query(`SELECT has_xmp AS v FROM assets WHERE id = ?`).get(assetId)).toEqual({ v: 0 });
  });

  test('reports no match for an unknown asset', async () => {
    using handle = await createTestDatabase();
    const result = await setHasXmp(new ObjectId(), true, testSqliteDb(handle.db));
    expect(result.matchedCount).toBe(0);
  });
});

describe('recordSidecarEdit', () => {
  test('marks the sidecar and bumps the edit counter in one statement', async () => {
    using handle = await createTestDatabase();
    const { db } = handle;
    const assetId = insertAsset(db);

    await recordSidecarEdit(oid(assetId), testSqliteDb(db));
    await recordSidecarEdit(oid(assetId), testSqliteDb(db));

    expect(db.query(`SELECT has_xmp, sidecar_ver FROM assets WHERE id = ?`).get(assetId)).toEqual({
      has_xmp: 1,
      sidecar_ver: 2,
    });
  });
});

describe('setPlaceOverride', () => {
  test('writes the place, recomposes the blob and re-arms the search stage', async () => {
    using handle = await createTestDatabase();
    const { db } = handle;
    const assetId = seedAsset(db);

    const result = await setPlaceOverride(oid(assetId), PLACE, testSqliteDb(db));
    expect(result.matchedCount).toBe(1);

    const stored = db.query(`SELECT place FROM assets WHERE id = ?`).get(assetId) as {
      place: string;
    };
    expect(JSON.parse(stored.place)).toEqual(PLACE);
    // Place tokens, caption, OCR text and the season for an April capture,
    // deduped and sorted — the exact contract of `composeSearchBlob`.
    expect(searchBlob(db, assetId)).toBe('a boat brooklyn new sea spring york');
    expect(stageState(db, assetId, 'meili')).toEqual({
      version: 0,
      attempts: 0,
      dead: 0,
      processed_at: null,
    });
  });

  test('clearing the override drops the place and the place tokens', async () => {
    using handle = await createTestDatabase();
    const { db } = handle;
    const assetId = seedAsset(db);
    await setPlaceOverride(oid(assetId), PLACE, testSqliteDb(db));

    await setPlaceOverride(oid(assetId), null, testSqliteDb(db));
    expect(db.query(`SELECT place FROM assets WHERE id = ?`).get(assetId)).toEqual({ place: null });
    expect(searchBlob(db, assetId)).toBe('a boat sea spring');
  });

  test('drops the previous place tokens when the new place carries no search_blob', async () => {
    using handle = await createTestDatabase();
    const { db } = handle;
    const assetId = seedAsset(db);
    await setPlaceOverride(oid(assetId), PLACE, testSqliteDb(db));
    expect(searchBlob(db, assetId)).toBe('a boat brooklyn new sea spring york');

    // `PUT /api/assets/:id/place` validates the body as an open object and
    // casts it — `routes/assets/overrides.ts` — so an operator can re-place an
    // asset with a display name and rollups and no internal denormalised blob.
    // `search_blob` is then `undefined` at runtime however the type reads.
    const handWritten = {
      source: 'manual',
      display_name: 'Lisbon, Portugal',
      rollups: { locality: 'Lisbon', region: 'Lisboa', country_code: 'pt' },
    } as unknown as Place;

    await setPlaceOverride(oid(assetId), handWritten, testSqliteDb(db));

    // The tokens of the place that was just replaced must not survive it:
    // treating `undefined` as "the caller is not changing place" would leave
    // Brooklyn searchable on an asset now placed in Lisbon.
    expect(searchBlob(db, assetId)).toBe('a boat sea spring');
  });

  test('removes the search row entirely when nothing is left to index', async () => {
    using handle = await createTestDatabase();
    const { db } = handle;
    const libraryId = insertFolder(db);
    const assetId = insertAsset(db);
    insertLocation(db, { assetId, libraryId, filename: 'a.dng' });

    await setPlaceOverride(oid(assetId), PLACE, testSqliteDb(db));
    expect(searchBlob(db, assetId)).toBe('brooklyn new york');

    await setPlaceOverride(oid(assetId), null, testSqliteDb(db));
    expect(searchBlob(db, assetId)).toBeNull();
  });

  test('writes nothing for an unknown asset', async () => {
    using handle = await createTestDatabase();
    const { db } = handle;
    const result = await setPlaceOverride(new ObjectId(), PLACE, testSqliteDb(db));
    expect(result.matchedCount).toBe(0);
    expect(db.query(`SELECT COUNT(*) AS n FROM asset_search`).get()).toEqual({ n: 0 });
  });
});

describe('setDescriptionOverride', () => {
  test('writes the caption, recomposes the blob and re-arms the search stage', async () => {
    using handle = await createTestDatabase();
    const { db } = handle;
    const assetId = seedAsset(db);
    run(db, `UPDATE assets SET place = ? WHERE id = ?`, JSON.stringify(PLACE), assetId);

    await setDescriptionOverride(oid(assetId), 'a red kayak', testSqliteDb(db));

    expect(
      db.query(`SELECT description FROM asset_detail WHERE asset_id = ?`).get(assetId),
    ).toEqual({ description: 'a red kayak' });
    expect(searchBlob(db, assetId)).toBe('a brooklyn kayak new red sea spring york');
    expect(stageState(db, assetId, 'meili')?.version).toBe(0);
  });

  test('creates the detail row when the asset has never been enriched', async () => {
    using handle = await createTestDatabase();
    const { db } = handle;
    const libraryId = insertFolder(db);
    const assetId = insertAsset(db);
    insertLocation(db, { assetId, libraryId, filename: 'a.dng' });

    await setDescriptionOverride(oid(assetId), 'lone caption', testSqliteDb(db));
    expect(
      db.query(`SELECT description FROM asset_detail WHERE asset_id = ?`).get(assetId),
    ).toEqual({ description: 'lone caption' });
    expect(searchBlob(db, assetId)).toBe('caption lone');
  });

  test('clearing the caption leaves the other sources indexed', async () => {
    using handle = await createTestDatabase();
    const { db } = handle;
    const assetId = seedAsset(db);

    await setDescriptionOverride(oid(assetId), null, testSqliteDb(db));
    expect(searchBlob(db, assetId)).toBe('sea spring');
  });

  test('re-arms a stage whose bookkeeping row does not exist yet', async () => {
    using handle = await createTestDatabase();
    const { db } = handle;
    const libraryId = insertFolder(db);
    const assetId = insertAsset(db);
    insertLocation(db, { assetId, libraryId, filename: 'a.dng' });
    expect(stageState(db, assetId, 'meili')).toBeNull();

    await setDescriptionOverride(oid(assetId), 'x', testSqliteDb(db));
    expect(stageState(db, assetId, 'meili')).toEqual({
      version: 0,
      attempts: 0,
      dead: 0,
      processed_at: null,
    });
  });
});

describe('requeueEnrichmentStage', () => {
  test('bumps the version and clears every claim field', async () => {
    using handle = await createTestDatabase();
    const { db } = handle;
    const assetId = insertAsset(db);
    insertEnrichmentState(db, assetId, 'describe', {
      doneAt: '2026-04-01T00:00:00Z',
      lockedBy: 'worker-1',
      leaseExpiresAt: '2026-04-01T01:00:00Z',
      attempts: 3,
      lastError: 'boom',
      version: 4,
      deadLetterAt: '2026-04-01T02:00:00Z',
    });

    const result = await requeueEnrichmentStage(oid(assetId), 'describe', testSqliteDb(db));
    expect(result).toEqual({ version: 5 });
    expect(
      db
        .query(`SELECT * FROM enrichment_state WHERE asset_id = ? AND stage = 'describe'`)
        .get(assetId),
    ).toEqual({
      asset_id: assetId,
      stage: 'describe',
      done_at: null,
      locked_by: null,
      lease_expires_at: null,
      attempts: 0,
      last_error: null,
      version: 5,
      dead_letter_at: null,
    });
  });

  test('starts at version 1 when the stage has no row yet', async () => {
    using handle = await createTestDatabase();
    const { db } = handle;
    const assetId = insertAsset(db);

    expect(await requeueEnrichmentStage(oid(assetId), 'geocode', testSqliteDb(db))).toEqual({
      version: 1,
    });
  });

  test('returns null for an unknown asset', async () => {
    using handle = await createTestDatabase();
    expect(
      await requeueEnrichmentStage(new ObjectId(), 'face', testSqliteDb(handle.db)),
    ).toBeNull();
  });
});

describe('clearCfThumbSyncedAt', () => {
  const syncedAt = (db: Parameters<typeof insertAsset>[0], id: string): string | null | undefined =>
    (
      db.query(`SELECT cf_thumb_synced_at AS at FROM assets WHERE id = ?`).get(id) as {
        at: string | null;
      } | null
    )?.at;

  test('forgets that the thumbnail was mirrored', async () => {
    using handle = await createTestDatabase();
    const { db } = handle;
    const assetId = insertAsset(db);
    run(
      db,
      `UPDATE assets SET cf_thumb_synced_at = ? WHERE id = ?`,
      '2026-01-01T00:00:00.000Z',
      assetId,
    );

    expect(await clearCfThumbSyncedAt(oid(assetId), testSqliteDb(db))).toMatchObject({
      matchedCount: 1,
    });
    expect(syncedAt(db, assetId)).toBeNull();
  });

  test('is a no-op on an asset that was never mirrored, and still reports the match', async () => {
    using handle = await createTestDatabase();
    const { db } = handle;
    const assetId = insertAsset(db);

    expect(await clearCfThumbSyncedAt(oid(assetId), testSqliteDb(db))).toMatchObject({
      matchedCount: 1,
    });
    expect(syncedAt(db, assetId)).toBeNull();
  });

  test('reports no match for an asset that does not exist', async () => {
    using handle = await createTestDatabase();
    expect(await clearCfThumbSyncedAt(new ObjectId(), testSqliteDb(handle.db))).toMatchObject({
      matchedCount: 0,
    });
  });
});
