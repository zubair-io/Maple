/**
 * Schema constraints: the guarantees the DDL is supposed to make, exercised
 * against a real database rather than read off the SQL.
 *
 * The cases that matter most are the ones that encode behaviour the Mongo
 * schema only had by convention — same-entry ("ANY location") matching, the
 * derived live-location count, and the uniqueness that stops two assets
 * claiming one file.
 */

import { describe, expect, test } from 'bun:test';
import {
  insertAsset,
  insertFolder,
  insertLocation,
  liveLocationCount,
  openMigratedDatabase,
} from './test-sqlite.test-helpers.ts';
import { newObjectIdHex } from './object-id.ts';

describe('assets', () => {
  test('rejects an id that is not a 24-character hex string', async () => {
    const { db } = await openMigratedDatabase();
    expect(() =>
      db.run(
        `INSERT INTO assets (id, size, mtime, indexed_at) VALUES ('short', 1, 1, '2026-01-01')`,
      ),
    ).toThrow(/CHECK constraint failed/);
    db.close();
  });

  test('rejects out-of-range rating and flag values', async () => {
    const { db } = await openMigratedDatabase();
    const id = newObjectIdHex();
    expect(() =>
      db.run(
        `INSERT INTO assets (id, size, mtime, indexed_at, rating) VALUES (?, 1, 1, '2026-01-01', 9)`,
        id,
      ),
    ).toThrow(/CHECK constraint failed/);
    expect(() =>
      db.run(
        `INSERT INTO assets (id, size, mtime, indexed_at, flag) VALUES (?, 1, 1, '2026-01-01', 2)`,
        id,
      ),
    ).toThrow(/CHECK constraint failed/);
    db.close();
  });

  test('rejects malformed JSON in a payload column', async () => {
    const { db } = await openMigratedDatabase();
    // Two guards catch this, and the generated column gets there first: its
    // json_extract refuses the text before the json_valid CHECK is evaluated.
    // Either way the row does not land.
    expect(() => insertAsset(db, { exif: '{not json' })).toThrow(
      /malformed JSON|CHECK constraint failed/,
    );
    const rows = db.query(`SELECT COUNT(*) AS n FROM assets`).get() as { n: number };
    expect(rows.n).toBe(0);
    db.close();
  });

  test('generated columns expose the queried EXIF and place paths', async () => {
    const { db } = await openMigratedDatabase();
    const id = insertAsset(db, {
      exif: JSON.stringify({
        captured_at: '2024-06-01T10:00:00.000Z',
        captured_year: 2024,
        captured_month: 6,
        camera_make: 'Hasselblad',
        camera_model: 'L3D-100c',
        lens: 'Hasselblad 24mm f/1.5',
        iso: 100,
        gps: { lat: 42.65, lng: -73.75 },
      }),
      place: JSON.stringify({
        geocoder_version: 3,
        rollups: { country_code: 'us', region: 'New York', locality: 'Albany' },
      }),
    });

    const row = db
      .query(
        `SELECT captured_at, captured_year, captured_month, camera_make, camera_model, lens, iso,
                gps_lat, gps_lng, place_country_code, place_region, place_locality, geocoder_version
           FROM assets WHERE id = ?`,
      )
      .get(id) as Record<string, unknown>;

    expect(row).toEqual({
      captured_at: '2024-06-01T10:00:00.000Z',
      captured_year: 2024,
      captured_month: 6,
      camera_make: 'Hasselblad',
      camera_model: 'L3D-100c',
      lens: 'Hasselblad 24mm f/1.5',
      iso: 100,
      gps_lat: 42.65,
      gps_lng: -73.75,
      place_country_code: 'us',
      place_region: 'New York',
      place_locality: 'Albany',
      geocoder_version: 3,
    });
    db.close();
  });

  test('generated columns are null when the JSON payload is absent', async () => {
    const { db } = await openMigratedDatabase();
    const id = insertAsset(db);
    const row = db
      .query(
        `SELECT captured_at, camera_make, gps_lat, place_country_code FROM assets WHERE id = ?`,
      )
      .get(id) as Record<string, unknown>;
    expect(row).toEqual({
      captured_at: null,
      camera_make: null,
      gps_lat: null,
      place_country_code: null,
    });
    db.close();
  });

  test('the facet aggregation reads an index, not the table', async () => {
    const { db } = await openMigratedDatabase();
    const plan = (
      db
        .query(
          `EXPLAIN QUERY PLAN
             SELECT camera_make, camera_model, COUNT(*) FROM assets
              WHERE deleted_at IS NULL AND live_location_count > 0
              GROUP BY camera_make, camera_model`,
        )
        .all() as Array<{ detail: string }>
    )
      .map((r) => r.detail)
      .join(' | ');

    expect(plan).toContain('assets_facet_camera');
    expect(plan).not.toContain('SCAN assets\n');
    db.close();
  });
});

describe('asset_locations', () => {
  test('two assets cannot claim the same file', async () => {
    const { db } = await openMigratedDatabase();
    const library = insertFolder(db);
    const first = insertAsset(db);
    const second = insertAsset(db);

    insertLocation(db, { assetId: first, libraryId: library, path: 'a', filename: 'IMG_1.dng' });
    expect(() =>
      insertLocation(db, { assetId: second, libraryId: library, path: 'a', filename: 'IMG_1.dng' }),
    ).toThrow(/UNIQUE constraint failed/);
    db.close();
  });

  test('one asset cannot list the same array position twice', async () => {
    const { db } = await openMigratedDatabase();
    const library = insertFolder(db);
    const asset = insertAsset(db);

    insertLocation(db, { assetId: asset, libraryId: library, ordinal: 0, filename: 'a.dng' });
    expect(() =>
      insertLocation(db, { assetId: asset, libraryId: library, ordinal: 0, filename: 'b.dng' }),
    ).toThrow(/UNIQUE constraint failed/);
    db.close();
  });

  test('deleting an asset cascades to its locations', async () => {
    const { db } = await openMigratedDatabase();
    const library = insertFolder(db);
    const asset = insertAsset(db);
    insertLocation(db, { assetId: asset, libraryId: library });

    db.run(`DELETE FROM assets WHERE id = ?`, asset);
    const remaining = db
      .query(`SELECT COUNT(*) AS n FROM asset_locations WHERE asset_id = ?`)
      .get(asset) as { n: number };
    expect(remaining.n).toBe(0);
    db.close();
  });

  test('a location cannot point at a library that does not exist', async () => {
    const { db } = await openMigratedDatabase();
    const asset = insertAsset(db);
    expect(() => insertLocation(db, { assetId: asset, libraryId: newObjectIdHex() })).toThrow(
      /FOREIGN KEY constraint failed/,
    );
    db.close();
  });
});

describe('live_location_count', () => {
  test('counts live locations and follows every liveness change', async () => {
    const { db } = await openMigratedDatabase();
    const library = insertFolder(db);
    const asset = insertAsset(db);
    expect(liveLocationCount(db, asset)).toBe(0);

    insertLocation(db, { assetId: asset, libraryId: library, ordinal: 0, filename: 'a.dng' });
    expect(liveLocationCount(db, asset)).toBe(1);

    insertLocation(db, { assetId: asset, libraryId: library, ordinal: 1, filename: 'b.dng' });
    expect(liveLocationCount(db, asset)).toBe(2);

    // Tagged missing on disk — no longer live.
    db.run(
      `UPDATE asset_locations SET missing_since = '2026-01-01T00:00:00.000Z'
        WHERE asset_id = ? AND ordinal = 1`,
      asset,
    );
    expect(liveLocationCount(db, asset)).toBe(1);

    // Recovered by the reaper's re-stat.
    db.run(
      `UPDATE asset_locations SET missing_since = NULL WHERE asset_id = ? AND ordinal = 1`,
      asset,
    );
    expect(liveLocationCount(db, asset)).toBe(2);

    // Bytes replaced in place — the other non-live tag.
    db.run(
      `UPDATE asset_locations SET deleted_at = '2026-01-02T00:00:00.000Z'
        WHERE asset_id = ? AND ordinal = 0`,
      asset,
    );
    expect(liveLocationCount(db, asset)).toBe(1);

    db.run(`DELETE FROM asset_locations WHERE asset_id = ? AND ordinal = 1`, asset);
    expect(liveLocationCount(db, asset)).toBe(0);
    db.close();
  });

  test('a location moving between assets updates both counts', async () => {
    const { db } = await openMigratedDatabase();
    const library = insertFolder(db);
    const loser = insertAsset(db);
    const survivor = insertAsset(db);
    insertLocation(db, { assetId: loser, libraryId: library, filename: 'shared.dng' });

    expect(liveLocationCount(db, loser)).toBe(1);
    expect(liveLocationCount(db, survivor)).toBe(0);

    // What a duplicate merge does: re-point the entry at the survivor.
    db.run(`UPDATE asset_locations SET asset_id = ? WHERE asset_id = ?`, survivor, loser);

    expect(liveLocationCount(db, loser)).toBe(0);
    expect(liveLocationCount(db, survivor)).toBe(1);
    db.close();
  });
});

describe('same-entry (ANY location) matching', () => {
  test('conditions satisfied by different entries no longer match', async () => {
    const { db } = await openMigratedDatabase();
    const library = insertFolder(db);
    const asset = insertAsset(db);

    // Entry 0 is content-replaced; entry 1 is missing from disk. Every
    // individual liveness condition is satisfied by SOME entry, but no single
    // entry satisfies both — so the asset is not live.
    insertLocation(db, {
      assetId: asset,
      libraryId: library,
      ordinal: 0,
      filename: 'a.dng',
      deletedAt: '2026-01-01T00:00:00.000Z',
    });
    insertLocation(db, {
      assetId: asset,
      libraryId: library,
      ordinal: 1,
      filename: 'b.dng',
      missingSince: '2026-01-01T00:00:00.000Z',
    });

    expect(liveLocationCount(db, asset)).toBe(0);

    const live = db
      .query(
        `SELECT COUNT(*) AS n FROM assets a
          WHERE a.deleted_at IS NULL AND a.live_location_count > 0 AND a.id = ?`,
      )
      .get(asset) as { n: number };
    expect(live.n).toBe(0);
    db.close();
  });

  test('a phasset link pairs a device with its own local id', async () => {
    const { db } = await openMigratedDatabase();
    const asset = insertAsset(db);
    const first = new Date().toISOString();
    db.run(
      `INSERT INTO asset_phasset_links (asset_id, device_id, phasset_local_id, first_seen)
       VALUES (?, 'device-a', 'local-1', ?), (?, 'device-b', 'local-2', ?)`,
      asset,
      first,
      asset,
      first,
    );

    // The mismatched pair (device-a, local-2) must not resolve — it does today
    // via dotted paths in routes/backup-sidecar.ts.
    const mismatched = db
      .query(
        `SELECT COUNT(*) AS n FROM asset_phasset_links
          WHERE device_id = 'device-a' AND phasset_local_id = 'local-2'`,
      )
      .get() as { n: number };
    expect(mismatched.n).toBe(0);

    const matched = db
      .query(
        `SELECT asset_id FROM asset_phasset_links
          WHERE device_id = 'device-a' AND phasset_local_id = 'local-1'`,
      )
      .get() as { asset_id: string };
    expect(matched.asset_id).toBe(asset);
    db.close();
  });
});

describe('stage_state', () => {
  test('holds one row per asset and stage', async () => {
    const { db } = await openMigratedDatabase();
    const asset = insertAsset(db);
    db.run(`INSERT INTO stage_state (asset_id, stage, version) VALUES (?, 'exif', 3)`, asset);
    db.run(`INSERT INTO stage_state (asset_id, stage, version) VALUES (?, 'thumb', 1)`, asset);

    expect(() =>
      db.run(`INSERT INTO stage_state (asset_id, stage, version) VALUES (?, 'exif', 4)`, asset),
    ).toThrow(/UNIQUE constraint failed/);

    // Registering a stage is an insert, not a schema change.
    db.run(`INSERT INTO stage_state (asset_id, stage, version) VALUES (?, 'brand-new', 0)`, asset);
    const rows = db
      .query(`SELECT COUNT(*) AS n FROM stage_state WHERE asset_id = ?`)
      .get(asset) as { n: number };
    expect(rows.n).toBe(3);
    db.close();
  });

  test('the claim scan uses stage_claim', async () => {
    const { db } = await openMigratedDatabase();
    const plan = (
      db
        .query(
          `EXPLAIN QUERY PLAN
             SELECT asset_id FROM stage_state
              WHERE stage = 'exif' AND version < 4 AND dead = 0`,
        )
        .all() as Array<{ detail: string }>
    )
      .map((r) => r.detail)
      .join(' | ');
    expect(plan).toContain('stage_claim');
    db.close();
  });
});

describe('full-text search', () => {
  test('a blob inserted into asset_search becomes matchable, and stays in step', async () => {
    const { db } = await openMigratedDatabase();
    const asset = insertAsset(db);
    db.run(
      `INSERT INTO asset_search (asset_id, search_blob) VALUES (?, ?)`,
      asset,
      'Albany New York museum visit',
    );

    const hit = db
      .query(
        `SELECT s.asset_id FROM assets_fts f
           JOIN asset_search s ON s.rowid = f.rowid
          WHERE assets_fts MATCH 'museum'`,
      )
      .get() as { asset_id: string } | null;
    expect(hit?.asset_id).toBe(asset);

    // Stemming: the porter tokenizer matches 'visits' against 'visit'.
    const stemmed = db
      .query(`SELECT COUNT(*) AS n FROM assets_fts WHERE assets_fts MATCH 'visits'`)
      .get() as {
      n: number;
    };
    expect(stemmed.n).toBe(1);

    // Update replaces the postings rather than adding to them.
    db.run(
      `UPDATE asset_search SET search_blob = 'something else entirely' WHERE asset_id = ?`,
      asset,
    );
    const stale = db
      .query(`SELECT COUNT(*) AS n FROM assets_fts WHERE assets_fts MATCH 'museum'`)
      .get() as {
      n: number;
    };
    expect(stale.n).toBe(0);

    // Deleting the asset cascades to asset_search and retracts the postings.
    db.run(`DELETE FROM assets WHERE id = ?`, asset);
    const gone = db
      .query(`SELECT COUNT(*) AS n FROM assets_fts WHERE assets_fts MATCH 'entirely'`)
      .get() as {
      n: number;
    };
    expect(gone.n).toBe(0);
    db.close();
  });

  test('refuses an empty blob, which the Mongo partial text index excluded', async () => {
    const { db } = await openMigratedDatabase();
    const asset = insertAsset(db);
    expect(() =>
      db.run(`INSERT INTO asset_search (asset_id, search_blob) VALUES (?, '')`, asset),
    ).toThrow(/CHECK constraint failed/);
    db.close();
  });
});

describe('people and faces', () => {
  test('a person name is unique, case-insensitively, among live rows', async () => {
    const { db } = await openMigratedDatabase();
    const now = new Date().toISOString();
    const first = newObjectIdHex();
    db.run(
      `INSERT INTO people (id, name, created_at, updated_at) VALUES (?, 'Ada', ?, ?)`,
      first,
      now,
      now,
    );

    expect(() =>
      db.run(
        `INSERT INTO people (id, name, created_at, updated_at) VALUES (?, 'ada', ?, ?)`,
        newObjectIdHex(),
        now,
        now,
      ),
    ).toThrow(/UNIQUE constraint failed/);

    // A merged-away row does not hold its old name hostage.
    db.run(`UPDATE people SET merged_into = ? WHERE id = ?`, first, first);
    db.run(
      `INSERT INTO people (id, name, created_at, updated_at) VALUES (?, 'Ada', ?, ?)`,
      newObjectIdHex(),
      now,
      now,
    );
    db.close();
  });

  test('person lookup is a join, and deleting a person unassigns its faces', async () => {
    const { db } = await openMigratedDatabase();
    const now = new Date().toISOString();
    const person = newObjectIdHex();
    db.run(
      `INSERT INTO people (id, name, created_at, updated_at) VALUES (?, 'Grace', ?, ?)`,
      person,
      now,
      now,
    );
    const asset = insertAsset(db);
    db.run(
      `INSERT INTO faces (asset_id, face_index, person_id, confidence, bbox_x, bbox_y, bbox_w, bbox_h)
       VALUES (?, 0, ?, 0.98, 0.1, 0.1, 0.2, 0.2)`,
      asset,
      person,
    );

    const found = db
      .query(
        `SELECT a.id FROM assets a JOIN faces f ON f.asset_id = a.id
          WHERE f.person_id = ? AND f.hidden = 0`,
      )
      .get(person) as { id: string };
    expect(found.id).toBe(asset);

    db.run(`DELETE FROM people WHERE id = ?`, person);
    const orphan = db.query(`SELECT person_id FROM faces WHERE asset_id = ?`).get(asset) as {
      person_id: string | null;
    };
    expect(orphan.person_id).toBeNull();
    db.close();
  });
});
