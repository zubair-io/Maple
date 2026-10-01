import { expect, test } from 'bun:test';
import { createTestDatabase, testSqliteDb } from '../sqlite/test-sqlite.test-helpers.ts';
import { insertPreset, isPresetNameConflict, listPresets } from './presets.repo.ts';
import { findUserByEmail, insertUser } from './auth.users.repo.ts';

const now = '2026-09-30T00:00:00.000Z';
const preset = (name: string) => ({
  name,
  schema_version: 1,
  fields: {},
  created_at: now,
  updated_at: now,
});
const user = (email: string | null) => ({
  email,
  role: 'member' as const,
  created_at: now,
  last_seen_at: null,
});

const equivalents = [
  ['Café', 'CAFÉ'],
  ['Ω', 'ω'],
  ['é', 'e\u0301'],
  ['ＡＢ', 'ab'],
] as const;
for (const [spelling, equivalent] of equivalents) {
  test(`preset names share a Unicode identity: ${spelling}`, async () => {
    using handle = await createTestDatabase();
    const db = testSqliteDb(handle.db);
    await insertPreset(preset(spelling), db);
    const error = await insertPreset(preset(equivalent), db).catch((e: unknown) => e);
    expect(isPresetNameConflict(error)).toBe(true);
    expect((await listPresets(db)).map((p) => p.name)).toEqual([spelling]);
  });

  test(`email lookup and uniqueness share a Unicode identity: ${spelling}`, async () => {
    using handle = await createTestDatabase();
    const db = testSqliteDb(handle.db);
    const original = `${spelling}@example.com`;
    const alternate = `${equivalent}@EXAMPLE.COM`;
    const id = await insertUser(user(original), db);
    expect((await findUserByEmail(alternate, db))?._id.toHexString()).toBe(id.toHexString());
    expect((await findUserByEmail(alternate, db))?.email).toBe(original);
    await expect(insertUser(user(alternate), db)).rejects.toThrow(/UNIQUE/);
  });
}

test('accents remain distinct and passkey-only users do not acquire email identity', async () => {
  using handle = await createTestDatabase();
  const db = testSqliteDb(handle.db);
  await insertPreset(preset('Cafe'), db);
  await insertPreset(preset('Café'), db);
  await insertUser(user('e@example.com'), db);
  await insertUser(user('é@example.com'), db);
  const first = await insertUser(user(null), db);
  const second = await insertUser(user(null), db);
  expect(first.toHexString()).not.toBe(second.toHexString());
  expect((await listPresets(db)).map((p) => p.name)).toEqual(['Cafe', 'Café']);
});
