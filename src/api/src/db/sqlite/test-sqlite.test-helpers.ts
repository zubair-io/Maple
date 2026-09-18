/**
 * Shared setup for the SQLite schema tests.
 *
 * Opens an in-memory database, applies the pragmas the schema assumes, and
 * runs the migrations. `bun:sqlite` is used directly and deliberately: these
 * tests own the connection, there is no event loop to protect, and the schema
 * must not care how connections are managed.
 */

import { Database } from 'bun:sqlite';
import { SCHEMA_PRAGMAS } from './ddl/index.ts';
import { fromBunSqlite, runMigrations, type MigrationDb } from './migrate.ts';
import { ALL_MIGRATIONS } from './migrations/index.ts';
import { newObjectIdHex } from './object-id.ts';

/** An open in-memory database plus its {@link MigrationDb} view. */
export interface TestDb {
  db: Database;
  migrationDb: MigrationDb;
}

/** Opens an in-memory database with the schema's pragmas applied. */
export function openTestDatabase(): TestDb {
  const db = new Database(':memory:');
  for (const pragma of SCHEMA_PRAGMAS) {
    // WAL is a no-op on an in-memory database; the rest apply normally.
    db.exec(pragma);
  }
  return { db, migrationDb: fromBunSqlite(db) };
}

/** Opens an in-memory database and applies the full schema. */
export async function openMigratedDatabase(): Promise<TestDb> {
  const handle = openTestDatabase();
  await runMigrations(handle.migrationDb, ALL_MIGRATIONS);
  return handle;
}

/** Inserts a library root and returns its id. */
export function insertFolder(
  db: Database,
  overrides: { path?: string; slug?: string } = {},
): string {
  const id = newObjectIdHex();
  const path = overrides.path ?? `/libraries/${id}`;
  const slug = overrides.slug ?? `lib-${id.slice(-6)}`;
  db.run(
    `INSERT INTO folders (id, path, slug, label, file_count, created_at)
     VALUES (?, ?, ?, ?, 0, ?)`,
    id,
    path,
    slug,
    'Test library',
    new Date().toISOString(),
  );
  return id;
}

/** Inserts a minimal asset row and returns its id. */
export function insertAsset(
  db: Database,
  overrides: { exif?: string | null; place?: string | null; deletedAt?: string | null } = {},
): string {
  const id = newObjectIdHex();
  db.run(
    `INSERT INTO assets (id, size, mtime, indexed_at, exif, place, deleted_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    id,
    1024,
    Date.now(),
    new Date().toISOString(),
    overrides.exif ?? null,
    overrides.place ?? null,
    overrides.deletedAt ?? null,
  );
  return id;
}

/** Inserts one location for an asset. */
export function insertLocation(
  db: Database,
  args: {
    assetId: string;
    libraryId: string;
    ordinal?: number;
    path?: string;
    filename?: string;
    deletedAt?: string | null;
    missingSince?: string | null;
  },
): void {
  db.run(
    `INSERT INTO asset_locations
       (asset_id, ordinal, library_id, path, filename, deleted_at, missing_since)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    args.assetId,
    args.ordinal ?? 0,
    args.libraryId,
    args.path ?? 'vacation/2024',
    args.filename ?? `${args.assetId}.dng`,
    args.deletedAt ?? null,
    args.missingSince ?? null,
  );
}

/** Reads one asset's `live_location_count`. */
export function liveLocationCount(db: Database, assetId: string): number {
  const row = db.query(`SELECT live_location_count AS n FROM assets WHERE id = ?`).get(assetId) as {
    n: number;
  } | null;
  return row?.n ?? -1;
}
