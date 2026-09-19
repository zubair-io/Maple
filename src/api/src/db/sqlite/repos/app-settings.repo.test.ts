/**
 * `app_settings` behaviour, exercised through the repository rather than read
 * off the SQL.
 *
 * The cases worth having are the ones where a naive port would differ from
 * `$set` with `upsert`: creating the document on first write, leaving
 * unmentioned fields alone, reaching a nested path that does not exist yet,
 * and storing an explicit `null` rather than deleting the key.
 */

import { describe, expect, test } from 'bun:test';
import { createTestDatabase, testSqliteDb } from '../test-sqlite.test-helpers.ts';
import {
  deleteAppSettings,
  patchAppSettings,
  readAppSettings,
  unsetAppSettings,
} from './app-settings.repo.ts';

describe('readAppSettings', () => {
  test('returns null when nothing has written the document', async () => {
    using handle = await createTestDatabase();
    expect(await readAppSettings('enrichment', testSqliteDb(handle.db))).toBeNull();
  });

  test('carries the id back as _id, the way the Mongo document did', async () => {
    using handle = await createTestDatabase();
    const db = testSqliteDb(handle.db);
    await patchAppSettings('network', { port: 3000 }, db);
    expect(await readAppSettings<{ port: number }>('network', db)).toEqual({
      _id: 'network',
      port: 3000,
    });
  });
});

describe('patchAppSettings', () => {
  test('creates the document on first write', async () => {
    using handle = await createTestDatabase();
    const db = testSqliteDb(handle.db);
    await patchAppSettings('missing-reaper', { prune_window_hours: 24 }, db);
    const doc = await readAppSettings<{ prune_window_hours: number }>('missing-reaper', db);
    expect(doc?.prune_window_hours).toBe(24);
  });

  test('leaves fields the patch does not name alone', async () => {
    using handle = await createTestDatabase();
    const db = testSqliteDb(handle.db);
    await patchAppSettings('observability', { endpoint: 'http://a', sample_ratio: 0.5 }, db);
    await patchAppSettings('observability', { sample_ratio: 1 }, db);
    expect(
      await readAppSettings<{ endpoint: string; sample_ratio: number }>('observability', db),
    ).toEqual({ _id: 'observability', endpoint: 'http://a', sample_ratio: 1 });
  });

  test('creates the intermediate objects a dotted path needs', async () => {
    using handle = await createTestDatabase();
    const db = testSqliteDb(handle.db);
    // The migration settings row addresses per-migration state exactly this
    // way, and the id is kebab-case — which is why path segments are quoted.
    await patchAppSettings('migration', { 'migrations.refile-backups.enabled': true }, db);
    await patchAppSettings('migration', { 'migrations.refile-backups.batch_size': 50 }, db);
    const doc = await readAppSettings<{
      migrations: Record<string, { enabled: boolean; batch_size: number }>;
    }>('migration', db);
    expect(doc?.migrations['refile-backups']).toEqual({ enabled: true, batch_size: 50 });
  });

  test('stores an explicit null instead of dropping the key', async () => {
    using handle = await createTestDatabase();
    const db = testSqliteDb(handle.db);
    await patchAppSettings('cloudflare', { account_id: 'abc' }, db);
    await patchAppSettings('cloudflare', { account_id: null }, db);
    const doc = await readAppSettings<{ account_id: string | null }>('cloudflare', db);
    expect(doc).toHaveProperty('account_id');
    expect(doc?.account_id).toBeNull();
  });

  test('round-trips objects and arrays', async () => {
    using handle = await createTestDatabase();
    const db = testSqliteDb(handle.db);
    await patchAppSettings('pano', { servers: [{ url: 'http://a', enabled: true }] }, db);
    const doc = await readAppSettings<{ servers: Array<{ url: string; enabled: boolean }> }>(
      'pano',
      db,
    );
    expect(doc?.servers).toEqual([{ url: 'http://a', enabled: true }]);
  });

  test('a key carrying a quote or a backslash addresses the field it names', async () => {
    using handle = await createTestDatabase();
    const db = testSqliteDb(handle.db);
    // Inside a quoted path segment SQLite parses a JSON string, so these two
    // characters escape with a backslash. Doubling the quote — the SQL
    // convention — makes SQLite reject the whole path, so the write would not
    // land at all.
    await patchAppSettings('odd', { 'say "hi"': 1, 'back\\slash': 2 }, db);
    const doc = await readAppSettings<Record<string, number>>('odd', db);
    expect(doc?.['say "hi"']).toBe(1);
    expect(doc?.['back\\slash']).toBe(2);
    // And nothing was written under a truncated name.
    expect(Object.keys(doc ?? {}).sort()).toEqual(['_id', 'back\\slash', 'say "hi"']);
  });

  test('an unset reaches a key carrying a quote', async () => {
    using handle = await createTestDatabase();
    const db = testSqliteDb(handle.db);
    await patchAppSettings('odd', { 'say "hi"': 1, keep: 2 }, db);
    await unsetAppSettings('odd', ['say "hi"'], db);
    const doc = await readAppSettings<Record<string, number>>('odd', db);
    expect(Object.keys(doc ?? {}).sort()).toEqual(['_id', 'keep']);
  });

  test('an empty patch neither inserts nor throws', async () => {
    using handle = await createTestDatabase();
    const db = testSqliteDb(handle.db);
    await patchAppSettings('render', {}, db);
    await patchAppSettings('render', { gpu: undefined }, db);
    expect(await readAppSettings('render', db)).toBeNull();
  });
});

describe('unsetAppSettings', () => {
  test('removes only the named paths', async () => {
    using handle = await createTestDatabase();
    const db = testSqliteDb(handle.db);
    await patchAppSettings(
      'migration',
      { 'migrations.gone.enabled': true, 'migrations.kept.enabled': false },
      db,
    );
    await unsetAppSettings('migration', ['migrations.gone'], db);
    const doc = await readAppSettings<{ migrations: Record<string, unknown> }>('migration', db);
    expect(Object.keys(doc?.migrations ?? {})).toEqual(['kept']);
  });

  test('is a no-op on a document that does not exist', async () => {
    using handle = await createTestDatabase();
    const db = testSqliteDb(handle.db);
    await unsetAppSettings('nothing-here', ['a.b'], db);
    expect(await readAppSettings('nothing-here', db)).toBeNull();
  });
});

describe('deleteAppSettings', () => {
  test('returns the document to never-written', async () => {
    using handle = await createTestDatabase();
    const db = testSqliteDb(handle.db);
    await patchAppSettings('map', { tile_url: 'http://tiles' }, db);
    await deleteAppSettings('map', db);
    expect(await readAppSettings('map', db)).toBeNull();
  });
});
