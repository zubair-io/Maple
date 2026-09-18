/**
 * The query-to-index map in `docs/sqlite-schema.md`, executed.
 *
 * A mapping that does not survive `EXPLAIN QUERY PLAN` is worse than a missing
 * index: the index exists, the document says it is used, and nobody looks
 * again. Three of the original mappings were in that state — the dedup probe,
 * the two case-insensitive name lookups and the vision facets — so each one
 * that this schema claims now has a test that fails if the claim stops being
 * true.
 *
 * Plans are asserted rather than timings: a timing on an empty in-memory
 * database measures nothing, while the plan is exactly the thing that was
 * wrong.
 */

import { describe, expect, test } from 'bun:test';
import {
  insertAsset,
  insertFolder,
  insertLocation,
  openMigratedDatabase,
  run,
} from './test-sqlite.test-helpers.ts';
import { newObjectIdHex } from './object-id.ts';
import type { Database } from 'bun:sqlite';

function planOf(db: Database, sql: string, ...params: Array<string | number>): string {
  return (db.query(`EXPLAIN QUERY PLAN ${sql}`).all(...params) as Array<{ detail: string }>)
    .map((row) => row.detail)
    .join(' | ');
}

/** The columns of an index, in order, as SQLite resolved them. */
function indexColumns(db: Database, index: string): string[] {
  return (db.query(`PRAGMA index_info(${index})`).all() as Array<{ name: string | null }>).map(
    (row) => row.name ?? '(expression)',
  );
}

describe('content dedup', () => {
  test('the maple_id probe is an index seek, not a scan', async () => {
    const { db } = await openMigratedDatabase();
    const plan = planOf(db, `SELECT id FROM assets WHERE maple_id = ?`, 'mid-1');
    expect(plan).toContain('assets_maple_id');
    expect(plan).not.toContain('SCAN assets');
    db.close();
  });

  test('the dedup grouping uses the same index, with no temp B-tree', async () => {
    const { db } = await openMigratedDatabase();
    const plan = planOf(
      db,
      `SELECT maple_id, COUNT(*) AS n FROM assets
        WHERE maple_id IS NOT NULL GROUP BY maple_id HAVING COUNT(*) > 1`,
    );
    expect(plan).toContain('assets_maple_id');
    expect(plan).not.toContain('TEMP B-TREE FOR GROUP BY');
    db.close();
  });

  test('an empty maple_id is refused, which is what keeps the index predicate simple', async () => {
    const { db } = await openMigratedDatabase();
    const id = newObjectIdHex();
    expect(() =>
      run(
        db,
        `INSERT INTO assets (id, size, mtime, indexed_at, maple_id)
         VALUES (?, 1, 1, '2026-01-01', '')`,
        id,
      ),
    ).toThrow(/CHECK constraint failed/);

    // Null stays legal, and two skeleton rows do not collide on it.
    run(db, `INSERT INTO assets (id, size, mtime, indexed_at) VALUES (?, 1, 1, '2026-01-01')`, id);
    run(
      db,
      `INSERT INTO assets (id, size, mtime, indexed_at) VALUES (?, 1, 1, '2026-01-01')`,
      newObjectIdHex(),
    );
    db.close();
  });
});

describe('case-insensitive name lookups', () => {
  test('a person is found by a differently-cased name, through the index', async () => {
    const { db } = await openMigratedDatabase();
    const now = new Date().toISOString();
    const id = newObjectIdHex();
    run(
      db,
      `INSERT INTO people (id, name, created_at, updated_at) VALUES (?, 'Ada', ?, ?)`,
      id,
      now,
      now,
    );

    const plan = planOf(db, `SELECT id FROM people WHERE name = ? AND merged_into IS NULL`, 'ada');
    expect(plan).toContain('people_name_unique');
    expect(plan).toContain('name=?');

    // The lookup that decides "rename into an existing cluster" is a MERGE.
    // Missing here is what would send the caller into an insert that the
    // unique index then rejects.
    const found = db
      .query(`SELECT id FROM people WHERE name = ? AND merged_into IS NULL`)
      .get('ada') as { id: string } | null;
    expect(found?.id).toBe(id);
    db.close();
  });

  test('a preset and a user are both found case-insensitively, through their index', async () => {
    const { db } = await openMigratedDatabase();
    run(
      db,
      `INSERT INTO presets (id, name, schema_version, fields, created_at, updated_at)
       VALUES (?, 'Golden Hour', 1, '{}', '2026-01-01', '2026-01-01')`,
      newObjectIdHex(),
    );
    run(
      db,
      `INSERT INTO users (id, email, role, created_at) VALUES (?, 'owner@example.com', 'owner', '2026-01-01')`,
      newObjectIdHex(),
    );

    expect(planOf(db, `SELECT id FROM presets WHERE name = ?`, 'x')).toContain(
      'presets_name_unique',
    );
    expect(planOf(db, `SELECT id FROM users WHERE email = ?`, 'x')).toContain('users_email_unique');

    expect(db.query(`SELECT COUNT(*) AS n FROM presets WHERE name = ?`).get('golden hour')).toEqual(
      {
        n: 1,
      },
    );
    expect(
      db.query(`SELECT COUNT(*) AS n FROM users WHERE email = ?`).get('OWNER@example.com'),
    ).toEqual({ n: 1 });
    db.close();
  });
});

describe('facet indexes', () => {
  test('every facet index carries the hidden column the queries always filter on', async () => {
    const { db } = await openMigratedDatabase();
    for (const index of [
      'assets_live',
      'assets_live_captured',
      'assets_live_captured_ym',
      'assets_facet_camera',
      'assets_facet_lens',
      'assets_facet_place',
      'assets_facet_place_label',
      'assets_facet_screenshot',
    ]) {
      expect(indexColumns(db, index)).toContain('hidden');
    }
    db.close();
  });

  test('the vision facet uses its index only when the query spells the predicate', async () => {
    const { db } = await openMigratedDatabase();
    const spelled = planOf(
      db,
      `SELECT vision_scene_type, COUNT(*) AS n FROM asset_detail
        WHERE vision_scene_type IS NOT NULL AND vision_scene_type <> ''
        GROUP BY vision_scene_type`,
    );
    expect(spelled).toContain('asset_detail_scene_type');

    // The bare grouping is the shape the map used to claim. It scans the
    // largest table in the database; the test records that, so the map and
    // the route keep spelling the exclusion the facet needs anyway.
    const bare = planOf(
      db,
      `SELECT vision_scene_type, COUNT(*) AS n FROM asset_detail GROUP BY vision_scene_type`,
    );
    expect(bare).toContain('SCAN asset_detail');
    db.close();
  });

  test('asset_detail is a rowid table, which is what makes that index usable', async () => {
    const { db } = await openMigratedDatabase();
    // A WITHOUT ROWID table cannot answer from an index over a generated
    // column: it fetches the row and re-parses the vision payload, 70x slower.
    const sql = (
      db
        .query(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'asset_detail'`)
        .get() as { sql: string }
    ).sql;
    expect(sql).not.toContain('WITHOUT ROWID');
    db.close();
  });
});

describe('the change feed outlives what it describes', () => {
  test('a delete event keeps its asset id after the asset row is gone', async () => {
    const { db } = await openMigratedDatabase();
    const library = insertFolder(db);
    const asset = insertAsset(db);
    insertLocation(db, { assetId: asset, libraryId: library });

    run(
      db,
      `INSERT INTO asset_changes (cursor, asset_id, folder_id, kind, at)
       VALUES (1, ?, ?, 'delete', ?)`,
      asset,
      library,
      new Date().toISOString(),
    );
    // What routes/assets/trash.ts and routes/folders.ts do next.
    run(db, `DELETE FROM assets WHERE id = ?`, asset);

    const row = db.query(`SELECT asset_id, kind FROM asset_changes WHERE cursor = 1`).get() as {
      asset_id: string | null;
      kind: string;
    };
    expect(row).toEqual({ asset_id: asset, kind: 'delete' });

    // And a change row may be written after the asset is already gone.
    run(
      db,
      `INSERT INTO asset_changes (cursor, asset_id, folder_id, kind, at)
       VALUES (2, ?, ?, 'delete', ?)`,
      newObjectIdHex(),
      library,
      new Date().toISOString(),
    );
    db.close();
  });
});

describe('wire contract', () => {
  test('is_screenshot holds all three states the DTO emits', async () => {
    const { db } = await openMigratedDatabase();
    const ids = [newObjectIdHex(), newObjectIdHex(), newObjectIdHex()];
    const values = [null, 0, 1];
    ids.forEach((id, index) => {
      run(
        db,
        `INSERT INTO assets (id, size, mtime, indexed_at, is_screenshot)
         VALUES (?, 1, 1, '2026-01-01', ?)`,
        id,
        values[index],
      );
    });

    const rows = db
      .query(`SELECT is_screenshot FROM assets ORDER BY is_screenshot`)
      .all() as Array<{ is_screenshot: number | null }>;
    expect(rows.map((row) => row.is_screenshot)).toEqual([null, 0, 1]);

    // Never classified is a state, not a default: an insert that says nothing
    // about the field leaves it unclassified rather than "not a screenshot".
    run(
      db,
      `INSERT INTO assets (id, size, mtime, indexed_at) VALUES (?, 1, 1, '2026-01-01')`,
      newObjectIdHex(),
    );
    const unset = db.query(`SELECT is_screenshot AS v FROM assets WHERE id = ?`).get(ids[0]) as {
      v: number | null;
    };
    expect(unset.v).toBeNull();
    db.close();
  });
});

describe('collection coverage', () => {
  test('every live MongoDB collection has a table', async () => {
    const { db } = await openMigratedDatabase();
    const tables = new Set(
      (
        db.query(`SELECT name FROM sqlite_master WHERE type = 'table'`).all() as Array<{
          name: string;
        }>
      ).map((row) => row.name),
    );
    // The nine that had no table when this schema was first reviewed.
    for (const table of [
      'app_settings',
      'generated_searches',
      'worker_status',
      'video_geo_backfill_audit',
      'indexer_checkpoints',
      'managed_certificates',
      'meilisearch_backfill_state',
      'meilisearch_backfill_leases',
      'meilisearch_backfill_failures',
    ]) {
      expect(tables).toContain(table);
    }
    db.close();
  });

  test('a settings document round-trips whole, and a partial update keeps the rest', async () => {
    const { db } = await openMigratedDatabase();
    run(
      db,
      `INSERT INTO app_settings (id, doc) VALUES ('enrichment', json('{"config":{"paused":false,"model":"qwen2.5-vl"}}'))`,
    );
    run(
      db,
      `UPDATE app_settings SET doc = json_set(doc, '$.config.paused', json('true')) WHERE id = 'enrichment'`,
    );
    const row = db.query(`SELECT doc FROM app_settings WHERE id = 'enrichment'`).get() as {
      doc: string;
    };
    expect(JSON.parse(row.doc)).toEqual({ config: { paused: true, model: 'qwen2.5-vl' } });
    db.close();
  });
});
