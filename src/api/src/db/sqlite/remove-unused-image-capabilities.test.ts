import { expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { fromBunSqlite, runMigrations } from './migrate.ts';
import { ALL_MIGRATIONS } from './migrations/index.ts';
import { removeUnusedImageCapabilitiesMigration } from './migrations/0010-remove-unused-image-capabilities.ts';
import { createBlankTestDatabase, createTestDatabase } from './test-sqlite.test-helpers.ts';

const previous = ALL_MIGRATIONS.filter(
  (migration) => migration.id < removeUnusedImageCapabilitiesMigration.id,
);
const grantObjects = "SELECT name FROM sqlite_master WHERE name LIKE 'image_access_tokens%'";

function seedLegacyGrant(db: Database): void {
  db.run(
    "INSERT INTO image_access_tokens (id, path, purpose, created_at, expires_at) VALUES (?, '/api/thumb/demo/a.jpg', 'image-read', '2026-01-01', '2027-01-01')",
    ['a'.repeat(64)],
  );
}

test('an existing file drops unused grants and preserves users and refresh sessions', async () => {
  using handle = createBlankTestDatabase('file');
  await runMigrations(handle.migrationDb, previous);
  seedLegacyGrant(handle.db);
  handle.db.run(
    "INSERT INTO users (id, email, email_key, role, created_at) VALUES (?, 'owner@example.test', 'owner@example.test', 'owner', '2026-01-01')",
    ['1'.repeat(24)],
  );
  handle.db.run(
    "INSERT INTO refresh_tokens (id, token_hash, user_id, issued_at, expires_at, device_label) VALUES (?, ?, ?, '2026-01-01', '2027-01-01', 'Test device')",
    ['2'.repeat(24), 'b'.repeat(64), '1'.repeat(24)],
  );
  const users = handle.db.query('SELECT * FROM users').all();
  const sessions = handle.db.query('SELECT * FROM refresh_tokens').all();
  using reopened = new Database(handle.path);
  reopened.exec('PRAGMA foreign_keys = ON');
  const applied = await runMigrations(fromBunSqlite(reopened), ALL_MIGRATIONS);
  expect(applied.applied).toEqual([removeUnusedImageCapabilitiesMigration.id]);
  expect(reopened.query(grantObjects).all()).toEqual([]);
  expect(reopened.query('SELECT * FROM users').all()).toEqual(users);
  expect(reopened.query('SELECT * FROM refresh_tokens').all()).toEqual(sessions);
  expect(reopened.query('PRAGMA foreign_key_check').all()).toEqual([]);
  expect((await runMigrations(fromBunSqlite(reopened), ALL_MIGRATIONS)).applied).toEqual([]);
});

test('fresh installs have no unused grant table or expiry index', async () => {
  using handle = await createTestDatabase();
  expect(handle.db.query(grantObjects).all()).toEqual([]);
});

test('a failed upgrade restores grants and does not record completion', async () => {
  using handle = createBlankTestDatabase();
  await runMigrations(handle.migrationDb, previous);
  seedLegacyGrant(handle.db);
  const failed = {
    ...removeUnusedImageCapabilitiesMigration,
    async up(db: typeof handle.migrationDb) {
      await removeUnusedImageCapabilitiesMigration.up(db);
      throw new Error('interrupted grant cleanup');
    },
  };
  await expect(runMigrations(handle.migrationDb, [...previous, failed])).rejects.toThrow(
    'interrupted grant cleanup',
  );
  expect(handle.db.query(grantObjects).all()).toHaveLength(2);
  expect(handle.db.query('SELECT id FROM image_access_tokens').all()).toEqual([
    { id: 'a'.repeat(64) },
  ]);
  expect(
    handle.db.query('SELECT id FROM schema_migrations WHERE id = ?').get(failed.id),
  ).toBeNull();
  await runMigrations(handle.migrationDb, ALL_MIGRATIONS);
  expect(handle.db.query(grantObjects).all()).toEqual([]);
});
