import { expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { createPerson } from '../repos/people.repo.ts';
import { insertPreset } from '../repos/presets.repo.ts';
import { findUserByEmail, insertUser } from '../repos/auth.users.repo.ts';
import { fromBunSqlite, runMigrations } from './migrate.ts';
import { ALL_MIGRATIONS } from './migrations/index.ts';
import { greekSigmaIdentityKeysMigration } from './migrations/0012-greek-sigma-identity-keys.ts';
import {
  createBlankTestDatabase,
  createTestDatabase,
  testSqliteDb,
} from './test-sqlite.test-helpers.ts';

const previous = ALL_MIGRATIONS.filter((m) => m.id < greekSigmaIdentityKeysMigration.id);
const tables = ['people', 'presets', 'users'] as const;
type IdentityTable = (typeof tables)[number];
const idFor = (table: IdentityTable) => String(tables.indexOf(table) + 1).repeat(24);

function seedLegacy(db: Database, table: IdentityTable, id = idFor(table), name = 'ΟΣ'): void {
  const key = name.normalize('NFKC').toLowerCase();
  if (table === 'people') {
    db.run(
      "INSERT INTO people (id, name, name_key, created_at, updated_at) VALUES (?, ?, ?, 'created', 'updated')",
      [id, name, key],
    );
  } else if (table === 'presets') {
    db.run(
      "INSERT INTO presets (id, name, name_key, schema_version, fields, extra, created_at, updated_at) VALUES (?, ?, ?, 9, ?, ?, 'created', 'updated')",
      [id, name, key, '{"exposure":1.25}', '{"future":true}'],
    );
  } else {
    db.run(
      "INSERT INTO users (id, email, email_key, role, file_access, created_at) VALUES (?, ?, ?, 'owner', 0, 'created')",
      [id, `${name}@example.com`, `${key}@example.com`],
    );
  }
}

test('existing file upgrades sigma keys without changing display data, references or nullable email', async () => {
  using file = createBlankTestDatabase('file');
  await runMigrations(file.migrationDb, previous);
  for (const table of tables) seedLegacy(file.db, table);
  file.db.run(
    "INSERT INTO people (id, name, name_key, created_at, updated_at, merged_into) VALUES (?, 'οσ', 'οσ', 'created', 'updated', ?)",
    ['4'.repeat(24), idFor('people')],
  );
  file.db.run("INSERT INTO users (id, role, created_at) VALUES (?, 'member', 'created')", [
    '5'.repeat(24),
  ]);
  file.db.run(
    "INSERT INTO credentials (id, user_id, credential_id, public_key, counter, device_label, created_at) VALUES (?, ?, 'credential', X'010203', 42, 'device', 'created')",
    ['6'.repeat(24), idFor('users')],
  );
  file.db.run(
    "INSERT INTO assets (id, size, mtime, indexed_at, owner_id) VALUES (?, 100, 1, 'indexed', ?)",
    ['8'.repeat(24), idFor('users')],
  );
  file.db.run(
    'INSERT INTO faces (asset_id, face_index, person_id, confidence, bbox_x, bbox_y, bbox_w, bbox_h) VALUES (?, 0, ?, 1, 0, 0, 1, 1)',
    ['8'.repeat(24), idFor('people')],
  );
  const before = tables.map((table) =>
    file.db.query<Record<string, unknown>, []>(`SELECT * FROM ${table} ORDER BY id`).all(),
  );
  const references = ['credentials', 'assets', 'faces'].map((table) =>
    file.db.query(`SELECT * FROM ${table}`).all(),
  );
  using reopened = new Database(file.path);
  reopened.exec('PRAGMA foreign_keys = ON');
  const result = await runMigrations(fromBunSqlite(reopened), ALL_MIGRATIONS);
  expect(result.applied).toEqual([greekSigmaIdentityKeysMigration.id]);
  for (const [index, table] of tables.entries()) {
    const key = table === 'users' ? 'email_key' : 'name_key';
    const after = reopened.query(`SELECT * FROM ${table} ORDER BY id`).all();
    expect(after).toEqual(
      before[index].map((row: Record<string, unknown>) => ({
        ...row,
        [key]: row[key] === null ? null : String(row[key]).replaceAll('ς', 'σ'),
      })),
    );
  }
  for (const [index, table] of ['credentials', 'assets', 'faces'].entries()) {
    expect(reopened.query(`SELECT * FROM ${table}`).all()).toEqual(references[index]);
  }
  expect(reopened.query('PRAGMA foreign_key_check').all()).toEqual([]);
  expect((await runMigrations(fromBunSqlite(reopened), ALL_MIGRATIONS)).applied).toEqual([]);
});

for (const table of tables) {
  test(`${table} sigma collision rejects and rolls back the whole upgrade, then retries after explicit resolution`, async () => {
    using file = createBlankTestDatabase('file');
    await runMigrations(file.migrationDb, previous);
    for (const item of tables) seedLegacy(file.db, item);
    const duplicate = '7'.repeat(24);
    seedLegacy(file.db, table, duplicate, 'οσ');
    const before = tables.map((item) => file.db.query(`SELECT * FROM ${item} ORDER BY id`).all());
    await expect(runMigrations(file.migrationDb, ALL_MIGRATIONS)).rejects.toThrow(
      `Greek sigma identity collision in ${table}`,
    );
    for (const [index, item] of tables.entries()) {
      expect(file.db.query(`SELECT * FROM ${item} ORDER BY id`).all()).toEqual(before[index]);
    }
    expect(
      file.db
        .query('SELECT id FROM schema_migrations WHERE id = ?')
        .get(greekSigmaIdentityKeysMigration.id),
    ).toBeNull();
    const source = table === 'users' ? 'email' : 'name';
    const key = table === 'users' ? 'email_key' : 'name_key';
    const distinct = table === 'users' ? 'distinct@example.com' : 'distinct';
    file.db.run(`UPDATE ${table} SET ${source} = ?, ${key} = ? WHERE id = ?`, [
      distinct,
      distinct,
      duplicate,
    ]);
    expect((await runMigrations(file.migrationDb, ALL_MIGRATIONS)).applied).toEqual([
      greekSigmaIdentityKeysMigration.id,
    ]);
    expect(file.db.query(`SELECT id FROM ${table} WHERE id = ?`).get(duplicate)).not.toBeNull();
  });
}

test('live people, preset and email repositories use the same sigma identity as ICU', async () => {
  using file = await createTestDatabase();
  const db = testSqliteDb(file.db);
  const person = await createPerson('ΟΣ', db);
  const samePerson = await createPerson('οσ', db);
  expect(samePerson._id.toHexString()).toBe(person._id.toHexString());
  const preset = {
    name: 'ΟΣ',
    schema_version: 9,
    fields: {},
    created_at: 'created',
    updated_at: 'updated',
  };
  await insertPreset(preset, db);
  await expect(insertPreset({ ...preset, name: 'οσ' }, db)).rejects.toThrow('presets.name_key');
  const owner = await insertUser(
    { email: 'ΟΣ@example.com', role: 'owner', created_at: 'created', last_seen_at: null },
    db,
  );
  expect((await findUserByEmail('οσ@example.com', db))?._id.toHexString()).toBe(
    owner.toHexString(),
  );
  await expect(
    insertUser(
      { email: 'οσ@example.com', role: 'member', created_at: 'created', last_seen_at: null },
      db,
    ),
  ).rejects.toThrow('users.email_key');
});
