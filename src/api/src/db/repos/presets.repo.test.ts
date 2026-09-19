/**
 * Named adjustment presets.
 *
 * The cases worth having are the two the collation decides — names sort and
 * collide case-insensitively — and the passthrough guarantee that a key this
 * server version does not understand survives a round trip.
 */

import { describe, expect, test } from 'bun:test';
import { ObjectId } from '../object-id.ts';
import { createTestDatabase, testSqliteDb } from '../sqlite/test-sqlite.test-helpers.ts';
import { deletePreset, insertPreset, isPresetNameConflict, listPresets } from './presets.repo.ts';
import type { SqliteDb } from './db-handle.ts';
import type { PresetDoc } from '../schema.ts';

const NOW = '2026-09-18T10:00:00.000Z';

function preset(name: string, overrides: Partial<PresetDoc> = {}): PresetDoc {
  return {
    name,
    schema_version: 1,
    fields: { exposure: 0.5, profile: 'auto' },
    created_at: NOW,
    updated_at: NOW,
    ...overrides,
  };
}

async function seed(db: SqliteDb, name: string, overrides: Partial<PresetDoc> = {}) {
  return await insertPreset(preset(name, overrides), db);
}

describe('presets', () => {
  test('a saved preset round-trips its fields', async () => {
    using handle = await createTestDatabase();
    const db = testSqliteDb(handle.db);
    const id = await seed(db, 'Punchy');
    const [saved] = await listPresets(db);
    expect(saved?._id.toHexString()).toBe(id.toHexString());
    expect(saved?.fields).toEqual({ exposure: 0.5, profile: 'auto' });
  });

  test('a preset with nothing to preserve has no extra key', async () => {
    using handle = await createTestDatabase();
    const db = testSqliteDb(handle.db);
    await seed(db, 'Punchy');
    expect((await listPresets(db))[0]).not.toHaveProperty('extra');
  });

  test('keys this version does not understand survive verbatim', async () => {
    using handle = await createTestDatabase();
    const db = testSqliteDb(handle.db);
    await seed(db, 'From the future', {
      schema_version: 9,
      extra: { grain: { amount: 3 }, unknown_flag: true },
    });
    const [saved] = await listPresets(db);
    expect(saved?.schema_version).toBe(9);
    expect(saved?.extra).toEqual({ grain: { amount: 3 }, unknown_flag: true });
  });

  test('names sort case-insensitively', async () => {
    using handle = await createTestDatabase();
    const db = testSqliteDb(handle.db);
    await seed(db, 'zebra');
    await seed(db, 'Apple');
    await seed(db, 'banana');
    expect((await listPresets(db)).map((p) => p.name)).toEqual(['Apple', 'banana', 'zebra']);
  });

  test('two names differing only in case cannot both exist', async () => {
    using handle = await createTestDatabase();
    const db = testSqliteDb(handle.db);
    await seed(db, 'Bright');
    const error = await seed(db, 'bright').catch((e: unknown) => e);
    expect(isPresetNameConflict(error)).toBe(true);
  });

  test('an unrelated failure is not reported as a duplicate name', async () => {
    expect(isPresetNameConflict(new Error('disk I/O error'))).toBe(false);
  });

  test('deleting reports whether there was anything to delete', async () => {
    using handle = await createTestDatabase();
    const db = testSqliteDb(handle.db);
    const id = await seed(db, 'Punchy');
    expect((await deletePreset(id, db)).deletedCount).toBe(1);
    expect((await deletePreset(new ObjectId(), db)).deletedCount).toBe(0);
    expect(await listPresets(db)).toHaveLength(0);
  });
});
