/**
 * The `assets`-table statements behind the Meilisearch backfill.
 *
 * The scan's contract is the part worth pinning: it is keyed on the asset id, it
 * skips rows with no content-dedup id, and it brings each row's locations and
 * faces with it without letting either widen the page. The coverage writes are
 * checked for the one distinction they exist to make — a fingerprint carries
 * forward only within its own document shape.
 */

import { describe, expect, test } from 'bun:test';
import type { Database } from 'bun:sqlite';
import {
  createTestDatabase,
  insertFolder,
  insertLocation,
  run,
  testSqliteDb,
} from '../test-sqlite.test-helpers.ts';
import { insertDetail, insertFaceRow, insertPersonRow } from './assets.test-helpers.ts';
import { newObjectIdHex } from '../../object-id.ts';
import {
  advanceVectorFingerprint,
  countLiveAssetRows,
  countLiveAssetRowsWithFingerprint,
  countMeiliAssetsAfter,
  hasMeiliAssetsAfter,
  loadMeiliAssetsAfter,
  loadMeiliAssetsByIds,
  markAssetRowsVectorized,
} from './assets.meilisearch.ts';

/** The columns an indexable asset carries when the caller says nothing. */
function defaultColumns(id: string): Record<string, string | number | null> {
  return {
    maple_id: `maple-${id}`,
    hidden: 0,
    is_screenshot: null,
    deleted_at: null,
    semantic_vector_fingerprint: null,
    exif: null,
    place: null,
  };
}

/** 1/0 for a boolean, and null or "not asked for" through unchanged. */
function bit(value: boolean | null | undefined): number | null | undefined {
  return typeof value === 'boolean' ? (value ? 1 : 0) : value;
}

/**
 * An asset whose id is chosen rather than random, so a test can assert the scan
 * order the cursor depends on.
 *
 * The overrides are a table merged over the defaults rather than a conditional
 * per column, which keeps the difference between "not asked for" and "asked
 * for as null" in one place: an absent key takes the default, and an explicit
 * null is stored as null. `maple_id` and `is_screenshot` both depend on that
 * distinction.
 */
function insertIndexable(
  db: Database,
  args: {
    id?: string;
    mapleId?: string | null;
    exif?: string | null;
    place?: string | null;
    hidden?: boolean;
    isScreenshot?: boolean | null;
    deletedAt?: string | null;
    fingerprint?: string | null;
  } = {},
): string {
  const id = args.id ?? newObjectIdHex();
  const overrides = {
    maple_id: args.mapleId,
    hidden: bit(args.hidden),
    is_screenshot: bit(args.isScreenshot),
    deleted_at: args.deletedAt,
    semantic_vector_fingerprint: args.fingerprint,
    exif: args.exif,
    place: args.place,
  };
  const row: Record<string, string | number | null> = {
    ...defaultColumns(id),
    ...omitUndefined(overrides),
  };
  run(
    db,
    `INSERT INTO assets
       (id, size, mtime, indexed_at, maple_id, hidden, is_screenshot, deleted_at,
        semantic_vector_fingerprint, exif, place)
     VALUES (?, 1, 1, ?, ?, ?, ?, ?, ?, ?, ?)`,
    id,
    '2026-01-01T00:00:00.000Z',
    row.maple_id,
    row.hidden,
    row.is_screenshot,
    row.deleted_at,
    row.semantic_vector_fingerprint,
    row.exif,
    row.place,
  );
  return id;
}

/** Every entry the caller actually asked for. */
function omitUndefined<T extends Record<string, unknown>>(values: T): Partial<T> {
  return Object.fromEntries(
    Object.entries(values).filter(([, value]) => value !== undefined),
  ) as Partial<T>;
}

/** An id built from one repeated hex digit, so ordering is obvious to read. */
const hexId = (digit: string): string => digit.repeat(24);

describe('loadMeiliAssetsAfter', () => {
  test('walks the library in id order, starting from the top', async () => {
    using handle = await createTestDatabase();
    const db = handle.db;
    for (const digit of ['3', '1', '2']) insertIndexable(db, { id: hexId(digit) });

    const batch = await loadMeiliAssetsAfter(null, 10, testSqliteDb(db));
    expect(batch.rows.map((row) => row.id)).toEqual([hexId('1'), hexId('2'), hexId('3')]);
  });

  test('resumes strictly after the cursor, and honours the batch size', async () => {
    using handle = await createTestDatabase();
    const db = handle.db;
    for (const digit of ['1', '2', '3', '4']) insertIndexable(db, { id: hexId(digit) });

    const batch = await loadMeiliAssetsAfter(hexId('2'), 1, testSqliteDb(db));
    expect(batch.rows.map((row) => row.id)).toEqual([hexId('3')]);
  });

  test('skips an asset with no content-dedup id', async () => {
    using handle = await createTestDatabase();
    const db = handle.db;
    const indexable = insertIndexable(db, { id: hexId('1') });
    insertIndexable(db, { id: hexId('2'), mapleId: null });

    const batch = await loadMeiliAssetsAfter(null, 10, testSqliteDb(db));
    expect(batch.rows.map((row) => row.id)).toEqual([indexable]);
  });

  test('includes a trashed asset, because the pass tombstones it rather than skipping it', async () => {
    using handle = await createTestDatabase();
    const db = handle.db;
    const id = insertIndexable(db, { deletedAt: '2026-01-01T00:00:00.000Z' });
    const batch = await loadMeiliAssetsAfter(null, 10, testSqliteDb(db));
    expect(batch.rows.map((row) => row.id)).toEqual([id]);
  });

  test('brings the detail payloads, the EXIF capture fields and the flags along', async () => {
    using handle = await createTestDatabase();
    const db = handle.db;
    const id = insertIndexable(db, {
      exif: JSON.stringify({ captured_at: '2026-04-01T09:00:00Z', captured_month: 4 }),
      place: JSON.stringify({ search_blob: 'albany' }),
      hidden: true,
      isScreenshot: true,
    });
    insertDetail(db, id, {
      description: 'a red bicycle',
      ocrText: 'OPEN',
      vision: JSON.stringify({ scene_type: 'street' }),
      transcript: JSON.stringify({ text: 'hello' }),
    });

    const [row] = (await loadMeiliAssetsAfter(null, 10, testSqliteDb(db))).rows;
    expect(row).toMatchObject({
      id,
      captured_at: '2026-04-01T09:00:00Z',
      captured_month: 4,
      hidden: 1,
      is_screenshot: 1,
      description: 'a red bicycle',
      ocr_text: 'OPEN',
      place: '{"search_blob":"albany"}',
      vision: '{"scene_type":"street"}',
      transcript: '{"text":"hello"}',
    });
  });

  test('an asset with no detail row still comes back, with null payloads', async () => {
    using handle = await createTestDatabase();
    const db = handle.db;
    insertIndexable(db);
    const [row] = (await loadMeiliAssetsAfter(null, 10, testSqliteDb(db))).rows;
    expect(row).toMatchObject({
      description: null,
      ocr_text: null,
      vision: null,
      transcript: null,
    });
  });

  test('locations arrive grouped and in array order without widening the page', async () => {
    using handle = await createTestDatabase();
    const db = handle.db;
    const library = insertFolder(db);
    const id = insertIndexable(db);
    insertLocation(db, { assetId: id, libraryId: library, ordinal: 0, filename: 'first.dng' });
    insertLocation(db, { assetId: id, libraryId: library, ordinal: 1, filename: 'second.dng' });

    const batch = await loadMeiliAssetsAfter(null, 10, testSqliteDb(db));
    expect(batch.rows).toHaveLength(1);
    expect(batch.locations.get(id)?.map((row) => row.filename)).toEqual([
      'first.dng',
      'second.dng',
    ]);
  });

  test('faces arrive as the person ids and geometry the name lookup needs', async () => {
    using handle = await createTestDatabase();
    const db = handle.db;
    const id = insertIndexable(db);
    const person = insertPersonRow(db, 'Ada');
    insertFaceRow(db, { assetId: id, faceIndex: 0, personId: person, confidence: 0.8 });
    insertFaceRow(db, { assetId: id, faceIndex: 1, personId: null });

    const batch = await loadMeiliAssetsAfter(null, 10, testSqliteDb(db));
    const faces = batch.faces.get(id) ?? [];
    expect(faces.map((face) => face.person_id)).toEqual([person, null]);
    expect(faces[0]).toMatchObject({ confidence: 0.8, bbox_x: 0.1, bbox_h: 0.4 });
  });

  test('an empty page asks nothing of the relation tables', async () => {
    using handle = await createTestDatabase();
    const batch = await loadMeiliAssetsAfter(null, 10, testSqliteDb(handle.db));
    expect(batch).toEqual({ rows: [], locations: new Map(), faces: new Map() });
  });
});

describe('loadMeiliAssetsByIds', () => {
  test('returns the named assets, including one that has lost its dedup id', async () => {
    using handle = await createTestDatabase();
    const db = handle.db;
    const withId = insertIndexable(db, { id: hexId('1') });
    const withoutId = insertIndexable(db, { id: hexId('2'), mapleId: null });
    insertIndexable(db, { id: hexId('3') });

    // The redrive needs the row of an asset the cursor pass would skip, so it
    // can decide the dead letter is stale rather than leaving it forever.
    const batch = await loadMeiliAssetsByIds([withId, withoutId], testSqliteDb(db));
    expect(batch.rows.map((row) => row.id).sort()).toEqual([withId, withoutId]);
  });

  test('an id that names nothing simply does not come back', async () => {
    using handle = await createTestDatabase();
    const batch = await loadMeiliAssetsByIds([hexId('9')], testSqliteDb(handle.db));
    expect(batch.rows).toEqual([]);
  });
});

describe('countMeiliAssetsAfter / hasMeiliAssetsAfter', () => {
  test('count the indexable suffix, not the whole library', async () => {
    using handle = await createTestDatabase();
    const db = handle.db;
    for (const digit of ['1', '2', '3']) insertIndexable(db, { id: hexId(digit) });
    insertIndexable(db, { id: hexId('4'), mapleId: null });

    const sqlite = testSqliteDb(db);
    expect(await countMeiliAssetsAfter(null, sqlite)).toBe(3);
    expect(await countMeiliAssetsAfter(hexId('1'), sqlite)).toBe(2);
    expect(await countMeiliAssetsAfter(hexId('3'), sqlite)).toBe(0);
  });

  test('the existence check answers the end of the pass', async () => {
    using handle = await createTestDatabase();
    const db = handle.db;
    insertIndexable(db, { id: hexId('1') });
    insertIndexable(db, { id: hexId('2') });

    const sqlite = testSqliteDb(db);
    expect(await hasMeiliAssetsAfter(hexId('1'), sqlite)).toBe(true);
    expect(await hasMeiliAssetsAfter(hexId('2'), sqlite)).toBe(false);
  });
});

describe('vector coverage', () => {
  /** A live asset: not trashed, and holding one location that is still there. */
  function insertLive(db: Database, fingerprint: string | null): string {
    const library = insertFolder(db);
    const id = insertIndexable(db, { fingerprint });
    insertLocation(db, { assetId: id, libraryId: library });
    return id;
  }

  test('marks exactly the assets whose documents landed', async () => {
    using handle = await createTestDatabase();
    const db = handle.db;
    const marked = insertIndexable(db, { id: hexId('1') });
    const untouched = insertIndexable(db, { id: hexId('2') });

    await markAssetRowsVectorized([marked], 'v8:abc', testSqliteDb(db));
    const rows = db
      .query(`SELECT id, semantic_vector_fingerprint AS fp FROM assets ORDER BY id`)
      .all() as Array<{ id: string; fp: string | null }>;
    expect(rows).toEqual([
      { id: marked, fp: 'v8:abc' },
      { id: untouched, fp: null },
    ]);
  });

  test('marking nothing is a no-op', async () => {
    using handle = await createTestDatabase();
    const db = handle.db;
    const id = insertIndexable(db, { fingerprint: 'v8:old' });
    await markAssetRowsVectorized([], 'v8:new', testSqliteDb(db));
    const [row] = db
      .query(`SELECT semantic_vector_fingerprint AS fp FROM assets WHERE id = ?`)
      .all(id) as Array<{ fp: string }>;
    expect(row?.fp).toBe('v8:old');
  });

  test('carries a live row forward within the same document shape', async () => {
    using handle = await createTestDatabase();
    const db = handle.db;
    const sameShape = insertLive(db, 'v8:old-model');

    await advanceVectorFingerprint('v8:', 'v8:new-model', testSqliteDb(db));
    const [row] = db
      .query(`SELECT semantic_vector_fingerprint AS fp FROM assets WHERE id = ?`)
      .all(sameShape) as Array<{ fp: string }>;
    expect(row?.fp).toBe('v8:new-model');
  });

  test('leaves a different shape, a legacy value and an unmarked row alone', async () => {
    using handle = await createTestDatabase();
    const db = handle.db;
    const otherShape = insertLive(db, 'v7:old');
    const legacy = insertLive(db, 'bare-sha256');
    const unmarked = insertLive(db, null);

    await advanceVectorFingerprint('v8:', 'v8:new', testSqliteDb(db));
    const byId = new Map(
      (
        db.query(`SELECT id, semantic_vector_fingerprint AS fp FROM assets`).all() as Array<{
          id: string;
          fp: string | null;
        }>
      ).map((row) => [row.id, row.fp]),
    );
    expect(byId.get(otherShape)).toBe('v7:old');
    expect(byId.get(legacy)).toBe('bare-sha256');
    expect(byId.get(unmarked)).toBeNull();
  });

  test('leaves a non-live row uncovered, because its document is not in the index', async () => {
    using handle = await createTestDatabase();
    const db = handle.db;
    // Marked at the right shape, but trashed — no live location backs it.
    const trashed = insertIndexable(db, {
      fingerprint: 'v8:old',
      deletedAt: '2026-01-01T00:00:00.000Z',
    });

    await advanceVectorFingerprint('v8:', 'v8:new', testSqliteDb(db));
    const [row] = db
      .query(`SELECT semantic_vector_fingerprint AS fp FROM assets WHERE id = ?`)
      .all(trashed) as Array<{ fp: string }>;
    expect(row?.fp).toBe('v8:old');
  });

  test('the two counts are the coverage ratio the status surface renders', async () => {
    using handle = await createTestDatabase();
    const db = handle.db;
    insertLive(db, 'v8:current');
    insertLive(db, 'v8:current');
    insertLive(db, 'v7:stale');
    // Trashed rows are in neither count.
    insertIndexable(db, { fingerprint: 'v8:current', deletedAt: '2026-01-01T00:00:00.000Z' });

    const sqlite = testSqliteDb(db);
    expect(await countLiveAssetRows(sqlite)).toBe(3);
    expect(await countLiveAssetRowsWithFingerprint('v8:current', sqlite)).toBe(2);
  });
});
