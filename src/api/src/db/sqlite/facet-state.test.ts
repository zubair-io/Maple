/**
 * The mirrored facet state, exercised through the writes that change it.
 *
 * `asset_detail`, `asset_locations`, `faces` and `asset_subjects` each carry
 * their asset's liveness and visibility, and the six facets that group those
 * tables read the mirror instead of joining `assets` (#3768). That is a
 * denormalisation, so the question this file exists to answer is the one a
 * denormalisation always raises: can it disagree with the thing it mirrors?
 *
 * It cannot, because nothing but a trigger writes it — but "nothing but a
 * trigger writes it" is only true while every write path that flips liveness or
 * visibility actually fires one. So each test below is a real write path: hide,
 * un-hide, trash, restore, lose a file, find it again, re-describe, merge a
 * duplicate. Each asserts the facets afterwards, which is where a stale mirror
 * would show up as a bucket that disagrees with the total beside it.
 *
 * The last test is the escape hatch the importer uses: rebuilding every
 * mirrored value in one pass has to land on exactly what the triggers would
 * have written, or a bulk import produces a library whose facets are wrong.
 */

import { describe, expect, test } from 'bun:test';
import type { Database } from 'bun:sqlite';
import { createTestDatabase, insertFolder, run, testSqliteDb } from './test-sqlite.test-helpers.ts';
import { FACET_STATE_RECOMPUTE_SQL } from './ddl/facet-state.ts';
import { hideAssetsInFolder } from '../repos/assets.folder-hidden.ts';
import { searchFacets } from '../repos/search.facets.ts';
import { buildSearchWhere } from '../repos/search.where.ts';
import { seedSearchAsset } from '../repos/search.test-helpers.ts';
import { toObjectId } from '../repos/values.ts';
import type { SearchQuery } from '../../routes/search/query-schema.ts';

/** Every mirrored row, as `table -> asset -> "live/hidden"`. */
function mirror(db: Database): string {
  const tables = ['asset_detail', 'asset_locations', 'faces', 'asset_subjects'];
  return tables
    .map((table) => {
      const rows = db
        .query(
          `SELECT asset_id, asset_live, asset_hidden FROM ${table}
            ORDER BY asset_id, asset_live, asset_hidden`,
        )
        .all() as Array<{ asset_id: string; asset_live: number; asset_hidden: number }>;
      return `${table}: ${rows.map((r) => `${r.asset_id}=${r.asset_live}/${r.asset_hidden}`).join(',')}`;
    })
    .join('\n');
}

/** The facets for one query, with the bucket values flattened for assertion. */
async function facetsOf(db: Database, query: SearchQuery = {}) {
  const where = buildSearchWhere(query);
  if ('error' in where) throw new Error(where.error);
  return searchFacets(where, testSqliteDb(db));
}

/** Bucket counts as a plain object, so an assertion reads as a table. */
function counts(buckets: Array<{ value: string; count: number }>): Record<string, number> {
  return Object.fromEntries(buckets.map((bucket) => [bucket.value, bucket.count]));
}

/** One library, one asset carrying a value in every satellite facet. */
function seedOne(db: Database, overrides: Parameters<typeof seedSearchAsset>[2] = {}) {
  const libraryId = insertFolder(db, { slug: 'trips' });
  const id = seedSearchAsset(db, libraryId, {
    filename: 'harbour.dng',
    sceneType: 'outdoor',
    activity: 'sailing',
    subjects: ['boat', 'water'],
    people: ['Ada'],
    ...overrides,
  });
  return { libraryId, id };
}

describe('the mirror follows visibility', () => {
  test('hiding an asset moves every satellite facet with it', async () => {
    using handle = await createTestDatabase();
    const { db } = handle;
    const { id } = seedOne(db);

    const before = await facetsOf(db);
    expect(counts(before.scene_types)).toEqual({ outdoor: 1 });
    expect(counts(before.subjects)).toEqual({ boat: 1, water: 1 });
    expect(counts(before.extensions)).toEqual({ dng: 1 });
    expect(before.people).toHaveLength(1);

    run(db, `UPDATE assets SET hidden = 1 WHERE id = ?`, id);

    const hiddenExcluded = await facetsOf(db);
    expect(hiddenExcluded.total).toBe(0);
    expect(hiddenExcluded.scene_types).toEqual([]);
    expect(hiddenExcluded.subjects).toEqual([]);
    expect(hiddenExcluded.extensions).toEqual([]);
    expect(hiddenExcluded.people).toEqual([]);

    // hidden=only is the inverse, and it has to use the same indexes — which
    // is why `asset_hidden` is a column of each one rather than part of its
    // `WHERE`.
    const only = await facetsOf(db, { hidden: 'only' });
    expect(only.total).toBe(1);
    expect(counts(only.scene_types)).toEqual({ outdoor: 1 });
    expect(counts(only.subjects)).toEqual({ boat: 1, water: 1 });
    expect(only.people).toHaveLength(1);

    run(db, `UPDATE assets SET hidden = 0 WHERE id = ?`, id);
    expect((await facetsOf(db)).total).toBe(1);
    expect(counts((await facetsOf(db)).activities)).toEqual({ sailing: 1 });
  });
});

describe('the mirror follows liveness', () => {
  test('trashing and restoring an asset take its buckets with them', async () => {
    using handle = await createTestDatabase();
    const { db } = handle;
    const { id } = seedOne(db);

    run(db, `UPDATE assets SET deleted_at = '2026-01-01T00:00:00.000Z' WHERE id = ?`, id);
    const trashed = await facetsOf(db);
    expect(trashed.total).toBe(0);
    expect(trashed.subjects).toEqual([]);
    expect(trashed.people).toEqual([]);

    run(db, `UPDATE assets SET deleted_at = NULL WHERE id = ?`, id);
    expect((await facetsOf(db)).total).toBe(1);
    expect(counts((await facetsOf(db)).subjects)).toEqual({ boat: 1, water: 1 });
  });

  test('losing the last file and finding it again do the same', async () => {
    using handle = await createTestDatabase();
    const { db } = handle;
    const { id } = seedOne(db);

    // The location trigger rewrites live_location_count, which fires the facet
    // trigger in turn. Two triggers deep, and nothing in the repository knows.
    run(db, `UPDATE asset_locations SET missing_since = '2026-01-01' WHERE asset_id = ?`, id);
    expect((await facetsOf(db)).total).toBe(0);
    expect((await facetsOf(db)).extensions).toEqual([]);

    run(db, `UPDATE asset_locations SET missing_since = NULL WHERE asset_id = ?`, id);
    expect((await facetsOf(db)).total).toBe(1);
    expect(counts((await facetsOf(db)).extensions)).toEqual({ dng: 1 });
  });

  test('a location moved to another asset takes the new asset state with it', async () => {
    using handle = await createTestDatabase();
    const { db } = handle;
    const libraryId = insertFolder(db, { slug: 'trips' });
    const visible = seedSearchAsset(db, libraryId, { filename: 'a.dng' });
    const hiddenAsset = seedSearchAsset(db, libraryId, { filename: 'b.jpg', hidden: true });

    // What a duplicate merge does (`repos/assets.merge.ts`): repoint the
    // location row at the surviving asset.
    run(
      db,
      `UPDATE asset_locations SET asset_id = ?, ordinal = 1 WHERE asset_id = ?`,
      visible,
      hiddenAsset,
    );
    expect(counts((await facetsOf(db)).extensions)).toEqual({ dng: 1 });
    const moved = db
      .query(`SELECT asset_live, asset_hidden FROM asset_locations WHERE filename = 'b.jpg'`)
      .get() as { asset_live: number; asset_hidden: number };
    expect(moved).toEqual({ asset_live: 1, asset_hidden: 0 });
  });
});

describe('asset_subjects is derived from the payload, not written beside it', () => {
  test('re-describing an asset replaces its subjects, and removing one removes it', async () => {
    using handle = await createTestDatabase();
    const { db } = handle;
    const { id } = seedOne(db);
    expect(counts((await facetsOf(db)).subjects)).toEqual({ boat: 1, water: 1 });

    // The describe stage's upsert, in the shape `assets.stage-patches.ts`
    // writes it: the whole `vision` payload is replaced.
    run(
      db,
      `UPDATE asset_detail SET vision = json(?) WHERE asset_id = ?`,
      JSON.stringify({ scene_type: 'outdoor', activity: 'sailing', subjects: ['lighthouse'] }),
      id,
    );
    expect(counts((await facetsOf(db)).subjects)).toEqual({ lighthouse: 1 });
  });

  test('a repeated subject is one row, so the facet agrees with its own filter', async () => {
    using handle = await createTestDatabase();
    const { db } = handle;
    const { id } = seedOne(db);
    run(
      db,
      `UPDATE asset_detail SET vision = json(?) WHERE asset_id = ?`,
      JSON.stringify({ subjects: ['boat', 'boat', 'water'] }),
      id,
    );
    // The shipped statement counted `json_each` rows, so this asset counted
    // twice in its own `boat` bucket while the `subjects=boat` filter returned
    // it once. The table holds one row per (asset, subject).
    expect(counts((await facetsOf(db)).subjects)).toEqual({ boat: 1, water: 1 });
    expect((await facetsOf(db, { subjects: 'boat' })).total).toBe(1);
  });

  test('a subjects value that is not an array contributes nothing and raises nothing', async () => {
    using handle = await createTestDatabase();
    const { db } = handle;
    const { id } = seedOne(db);
    // `json_extract` unwraps a JSON string into bare SQL text, and `json_each`
    // raises on anything that is not JSON — so without the type guard this
    // write would abort the describe stage rather than simply not match.
    for (const payload of ['{"subjects":"boat"}', '{"subjects":7}', '{}']) {
      run(db, `UPDATE asset_detail SET vision = json(?) WHERE asset_id = ?`, payload, id);
      expect((await facetsOf(db)).subjects).toEqual([]);
    }
  });

  test('deleting the detail row deletes the subjects it produced', async () => {
    using handle = await createTestDatabase();
    const { db } = handle;
    const { id } = seedOne(db);
    run(db, `DELETE FROM asset_detail WHERE asset_id = ?`, id);
    expect((await facetsOf(db)).subjects).toEqual([]);
    expect(db.query(`SELECT COUNT(*) AS n FROM asset_subjects`).get()).toEqual({ n: 0 });
  });
});

describe('the other triggers on assets', () => {
  test('a write that fires both trigger sets satisfies both (#3795, #3768)', async () => {
    using handle = await createTestDatabase();
    const { db } = handle;
    const { id } = seedOne(db, { filename: 'clip.mp4', mediaKind: 'image' });
    run(
      db,
      `INSERT INTO stage_state (asset_id, stage, version, attempts, dead) VALUES (?, 'thumb', 0, 0, 0)`,
      id,
    );

    // Two independent triggers watch `assets`, on disjoint columns: #3795
    // stamps `media_kind` onto `stage_state`, and #3768 mirrors liveness and
    // visibility onto the four facet satellites. One statement assigns a
    // column each of them watches, which is the case a clean textual merge of
    // the two branches would never have exercised.
    run(db, `UPDATE assets SET media_kind = 'video', hidden = 1 WHERE id = ?`, id);

    expect(db.query(`SELECT media_kind FROM stage_state WHERE asset_id = ?`).get(id)).toEqual({
      media_kind: 'video',
    });
    expect((await facetsOf(db)).total).toBe(0);
    expect((await facetsOf(db, { hidden: 'only' })).subjects).toHaveLength(2);

    // And the reverse order, on the same row.
    run(db, `UPDATE assets SET hidden = 0, media_kind = 'audio' WHERE id = ?`, id);
    expect(db.query(`SELECT media_kind FROM stage_state WHERE asset_id = ?`).get(id)).toEqual({
      media_kind: 'audio',
    });
    expect((await facetsOf(db)).total).toBe(1);
  });
});

describe('a row count still means rows of assets', () => {
  test('hiding a folder reports the assets it hid, not the rows it wrote', async () => {
    using handle = await createTestDatabase();
    const { db } = handle;
    const libraryId = insertFolder(db, { slug: 'trips' });
    const first = seedSearchAsset(db, libraryId, {
      filename: 'a.dng',
      subjects: ['boat', 'water', 'sky'],
      people: ['Ada', 'Grace'],
    });
    const second = seedSearchAsset(db, libraryId, { filename: 'b.jpg' });

    // `bun:sqlite` counts every row a statement wrote, trigger writes
    // included, so the `hidden` flip alone reports the two assets plus their
    // locations, faces, subjects and detail rows — eleven here. The operator
    // sees this number in a log line, and it has to be two.
    const hidden = await hideAssetsInFolder(
      [toObjectId(first), toObjectId(second)],
      toObjectId(libraryId),
      'trips/2024',
      testSqliteDb(db),
    );
    expect(hidden).toBe(2);
    expect((await facetsOf(db)).total).toBe(0);
    expect((await facetsOf(db, { hidden: 'only' })).total).toBe(2);
  });
});

describe('the recompute lands where the triggers would have', () => {
  test('rebuilding every mirrored value changes nothing on a trigger-built library', async () => {
    using handle = await createTestDatabase();
    const { db } = handle;
    const libraryId = insertFolder(db, { slug: 'trips' });
    seedSearchAsset(db, libraryId, { filename: 'a.dng', subjects: ['boat'], people: ['Ada'] });
    seedSearchAsset(db, libraryId, { filename: 'b.jpg', hidden: true, subjects: ['bread'] });
    seedSearchAsset(db, libraryId, { filename: 'c.tif', deletedAt: '2026-01-01' });
    seedSearchAsset(db, libraryId, { filename: 'd.png', locationMissingSince: '2026-01-01' });

    const built = mirror(db);
    const facets = await facetsOf(db);
    db.exec(FACET_STATE_RECOMPUTE_SQL);

    // The importer drops the triggers for its bulk load and runs this instead.
    // If the two ever disagreed, an imported library's facets would be wrong
    // and nothing would say so.
    expect(mirror(db)).toBe(built);
    expect(await facetsOf(db)).toEqual(facets);
  });
});
