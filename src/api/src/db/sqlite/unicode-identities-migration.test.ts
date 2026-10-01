import { expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { caseFoldKey } from './case-fold.ts';
import { fromBunSqlite, runMigrations } from './migrate.ts';
import { ALL_MIGRATIONS } from './migrations/index.ts';
import { unicodePresetEmailKeysMigration } from './migrations/0009-unicode-preset-email-keys.ts';
import { createBlankTestDatabase, createTestDatabase } from './test-sqlite.test-helpers.ts';

const previous = ALL_MIGRATIONS.filter((m) => m.id < unicodePresetEmailKeysMigration.id);
const owner = '1'.repeat(24);
const preset = '2'.repeat(24);

function seedUser(db: Database, id = owner, email: string | null = 'JOSÉ@example.com'): void {
  db.run(
    "INSERT INTO users (id, email, role, file_access, created_at, last_seen_at) VALUES (?, ?, 'owner', 0, 'created', 'seen')",
    [id, email],
  );
}

function seedPreset(db: Database, id = preset, name = 'Café'): void {
  db.run(
    "INSERT INTO presets (id, name, schema_version, fields, extra, created_at, updated_at) VALUES (?, ?, 9, ?, ?, 'created', 'updated')",
    [id, name, '{ "exposure": 1.25 }', '{ "future": {"enabled":true} }'],
  );
}

test('an existing file backfills Unicode keys without changing values or account references', async () => {
  using handle = createBlankTestDatabase('file');
  await runMigrations(handle.migrationDb, previous);
  const db = handle.db;
  seedUser(db);
  seedUser(db, '3'.repeat(24), null);
  seedUser(db, '4'.repeat(24), null);
  seedPreset(db);
  db.exec(`
    INSERT INTO credentials (id, user_id, credential_id, public_key, counter, device_label, created_at)
      VALUES ('${'5'.repeat(24)}', '${owner}', 'credential', X'010203', 42, 'device', 'created');
    INSERT INTO refresh_tokens (id, user_id, token_hash, issued_at, expires_at, device_label)
      VALUES ('${'6'.repeat(24)}', '${owner}', 'token', 'issued', 'expires', 'device');
    INSERT INTO service_api_keys (id, key_id, name, secret_hash, scopes, created_at, created_by)
      VALUES ('${'7'.repeat(24)}', 'key', 'service', 'hash', '[]', 'created', '${owner}');
    INSERT INTO challenges (id, challenge, purpose, user_id, expires_at)
      VALUES ('${'8'.repeat(24)}', 'challenge', 'authenticate', '${owner}', 'expires');
    INSERT INTO native_auth_codes (id, code_hash, code_challenge, state, user_id, device_label, created_at, expires_at)
      VALUES ('${'9'.repeat(24)}', 'hash', 'challenge', 'state', '${owner}', 'device', 'created', 'expires');
    INSERT INTO lan_handoff_codes (id, code_hash, user_id, device_label, created_at, expires_at)
      VALUES ('${'a'.repeat(24)}', 'hash', '${owner}', 'device', 'created', 'expires');
    INSERT INTO apns_device_tokens (id, user_id, device_token, platform, environment, created_at, updated_at)
      VALUES ('${'b'.repeat(24)}', '${owner}', 'token', 'macos', 'production', 'created', 'updated');
  `);
  const children = [
    'credentials',
    'refresh_tokens',
    'service_api_keys',
    'challenges',
    'native_auth_codes',
    'lan_handoff_codes',
    'apns_device_tokens',
  ];
  const before = children.map((table) => db.query(`SELECT * FROM ${table}`).all());
  const oldUsers = db.query('SELECT * FROM users ORDER BY id').all();
  const oldPreset = db.query('SELECT * FROM presets').get();

  using reopened = new Database(handle.path);
  reopened.exec('PRAGMA foreign_keys = ON');
  const result = await runMigrations(fromBunSqlite(reopened), ALL_MIGRATIONS);
  const again = await runMigrations(fromBunSqlite(reopened), ALL_MIGRATIONS);
  expect(result.applied).toEqual(
    ALL_MIGRATIONS.filter((migration) => migration.id >= unicodePresetEmailKeysMigration.id).map(
      (migration) => migration.id,
    ),
  );
  expect(again.applied).toEqual([]);
  expect(
    reopened
      .query('SELECT id, email, role, file_access, created_at, last_seen_at FROM users ORDER BY id')
      .all(),
  ).toEqual(oldUsers);
  expect(
    reopened
      .query('SELECT id, name, schema_version, fields, extra, created_at, updated_at FROM presets')
      .get(),
  ).toEqual(oldPreset);
  expect(reopened.query('SELECT name_key FROM presets').get()).toEqual({
    name_key: caseFoldKey('Café'),
  });
  expect(reopened.query('SELECT email_key FROM users WHERE id = ?').get(owner)).toEqual({
    email_key: caseFoldKey('JOSÉ@example.com'),
  });
  expect(
    reopened
      .query('SELECT COUNT(*) AS n FROM users WHERE email IS NULL AND email_key IS NULL')
      .get(),
  ).toEqual({ n: 2 });
  expect(children.map((table) => reopened.query(`SELECT * FROM ${table}`).all())).toEqual(before);
  expect(reopened.query('PRAGMA foreign_keys').get()).toEqual({ foreign_keys: 1 });
  expect(reopened.query('PRAGMA foreign_key_check').all()).toEqual([]);
  expect(() => reopened.run('DELETE FROM users WHERE id = ?', [owner])).toThrow(/FOREIGN KEY/);
  expect(children.map((table) => reopened.query(`SELECT * FROM ${table}`).all())).toEqual(before);
});

for (const table of ['presets', 'users'] as const) {
  test(`existing Unicode collisions in ${table} stop the upgrade without losing either identity`, async () => {
    using handle = createBlankTestDatabase();
    await runMigrations(handle.migrationDb, previous);
    seedUser(handle.db);
    seedPreset(handle.db);
    if (table === 'presets') seedPreset(handle.db, '3'.repeat(24), 'CAFÉ');
    else seedUser(handle.db, '3'.repeat(24), 'josé@EXAMPLE.COM');
    const users = handle.db.query('SELECT * FROM users ORDER BY id').all();
    const presets = handle.db.query('SELECT * FROM presets ORDER BY id').all();
    await expect(runMigrations(handle.migrationDb, ALL_MIGRATIONS)).rejects.toThrow(
      /UNIQUE constraint/,
    );
    expect(handle.db.query('SELECT * FROM users ORDER BY id').all()).toEqual(users);
    expect(handle.db.query('SELECT * FROM presets ORDER BY id').all()).toEqual(presets);
    expect(
      handle.db
        .query("SELECT name FROM sqlite_master WHERE name IN ('presets_unicode', 'users_unicode')")
        .all(),
    ).toEqual([]);
    expect(
      handle.db
        .query('SELECT id FROM schema_migrations WHERE id = ?')
        .get(unicodePresetEmailKeysMigration.id),
    ).toBeNull();
  });
}

test('new writes cannot omit a preset key or give an email and key different null states', async () => {
  using handle = await createTestDatabase();
  expect(() => seedPreset(handle.db)).toThrow(/NOT NULL/);
  expect(() => seedUser(handle.db)).toThrow(/CHECK/);
  expect(() =>
    handle.db.run(
      "INSERT INTO users (id, email_key, role, created_at) VALUES (?, 'key', 'owner', 'created')",
      [owner],
    ),
  ).toThrow(/CHECK/);
});
