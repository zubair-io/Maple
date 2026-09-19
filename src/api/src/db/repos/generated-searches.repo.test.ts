/**
 * `generated_searches` behaviour through the repository.
 *
 * Two rules here reach the product directly. Listing without a day has to mean
 * "the most recent day that produced anything for this library", which is what
 * keeps the widget and the TV shelf showing yesterday's set when a run is late
 * rather than showing an empty shelf. And the prune has to report how many rows
 * it removed, because the worker logs that number and Settings → Workers shows
 * it — a sweep that removed nothing has to be distinguishable from one that
 * never ran.
 */

import { describe, expect, test } from 'bun:test';
import { ObjectId } from '../object-id.ts';
import { newObjectIdHex } from '../object-id.ts';
import { createTestDatabase, testSqliteDb } from '../sqlite/test-sqlite.test-helpers.ts';
import {
  findGeneratedSearchById,
  listGeneratedSearches,
  pruneGeneratedSearches,
  saveGeneratedSearches,
} from './generated-searches.repo.ts';
import type { GeneratedSearchInput } from '../../workers/generated-search/repo.ts';

const LIB = newObjectIdHex();
const OTHER_LIB = newObjectIdHex();

function input(overrides: Partial<GeneratedSearchInput> = {}): GeneratedSearchInput {
  return {
    library_id: LIB,
    generated_for: '2026-08-17',
    generated_at: '2026-08-17T06:00:00.000Z',
    model: 'qwen2.5',
    attempts: 1,
    theme: 'golden hour',
    title: 'Golden hour',
    subtitle: 'Late light from last summer',
    query: { placeQuery: 'brooklyn', month: '8' },
    result_count: 42,
    cover_asset_id: newObjectIdHex(),
    ...overrides,
  };
}

describe('saveGeneratedSearches', () => {
  test('round-trips every field, including the opaque query bag', async () => {
    using handle = await createTestDatabase();
    const db = testSqliteDb(handle.db);
    const stored = input();
    await saveGeneratedSearches([stored], db);

    const [doc] = await listGeneratedSearches(LIB, '2026-08-17', db);
    expect(doc?.title).toBe('Golden hour');
    expect(doc?.subtitle).toBe('Late light from last summer');
    expect(doc?.model).toBe('qwen2.5');
    expect(doc?.attempts).toBe(1);
    expect(doc?.result_count).toBe(42);
    expect(doc?.cover_asset_id).toBe(stored.cover_asset_id);
    expect(doc?.query).toEqual({ placeQuery: 'brooklyn', month: '8' });
    expect(doc?._id.toHexString()).toHaveLength(24);
  });

  test('mints a distinct id per collection in one run', async () => {
    using handle = await createTestDatabase();
    const db = testSqliteDb(handle.db);
    await saveGeneratedSearches([input({ theme: 'a' }), input({ theme: 'b' })], db);

    const docs = await listGeneratedSearches(LIB, '2026-08-17', db);
    expect(docs).toHaveLength(2);
    expect(new Set(docs.map((d) => d._id.toHexString())).size).toBe(2);
  });

  test('stores a null subtitle and a null cover as nulls', async () => {
    using handle = await createTestDatabase();
    const db = testSqliteDb(handle.db);
    await saveGeneratedSearches([input({ subtitle: null, cover_asset_id: null })], db);

    const [doc] = await listGeneratedSearches(LIB, '2026-08-17', db);
    expect(doc?.subtitle).toBeNull();
    expect(doc?.cover_asset_id).toBeNull();
  });

  test('an empty run writes nothing and does not throw', async () => {
    using handle = await createTestDatabase();
    const db = testSqliteDb(handle.db);
    await saveGeneratedSearches([], db);
    expect(await listGeneratedSearches(LIB, undefined, db)).toEqual([]);
  });
});

describe('listGeneratedSearches', () => {
  test('scopes to one library', async () => {
    using handle = await createTestDatabase();
    const db = testSqliteDb(handle.db);
    await saveGeneratedSearches(
      [input(), input({ library_id: OTHER_LIB, theme: 'someone else' })],
      db,
    );

    const mine = await listGeneratedSearches(LIB, '2026-08-17', db);
    expect(mine).toHaveLength(1);
    expect(mine[0]?.theme).toBe('golden hour');
  });

  test('returns only the named day', async () => {
    using handle = await createTestDatabase();
    const db = testSqliteDb(handle.db);
    await saveGeneratedSearches(
      [input(), input({ generated_for: '2026-08-16', theme: 'older' })],
      db,
    );

    const today = await listGeneratedSearches(LIB, '2026-08-17', db);
    expect(today.map((d) => d.theme)).toEqual(['golden hour']);
  });

  test('falls back to the most recent day that produced anything', async () => {
    using handle = await createTestDatabase();
    const db = testSqliteDb(handle.db);
    await saveGeneratedSearches(
      [
        input({ generated_for: '2026-08-15', theme: 'oldest' }),
        input({ generated_for: '2026-08-17', theme: 'newest' }),
        input({ generated_for: '2026-08-16', theme: 'middle' }),
      ],
      db,
    );

    const latest = await listGeneratedSearches(LIB, undefined, db);
    expect(latest.map((d) => d.theme)).toEqual(['newest']);
  });

  test('the latest day is per library, not global', async () => {
    using handle = await createTestDatabase();
    const db = testSqliteDb(handle.db);
    await saveGeneratedSearches(
      [
        input({ library_id: LIB, generated_for: '2026-08-10', theme: 'mine' }),
        input({ library_id: OTHER_LIB, generated_for: '2026-08-17', theme: 'theirs' }),
      ],
      db,
    );

    const latest = await listGeneratedSearches(LIB, undefined, db);
    expect(latest.map((d) => d.theme)).toEqual(['mine']);
  });

  test('a library that has never produced anything answers empty', async () => {
    using handle = await createTestDatabase();
    expect(await listGeneratedSearches(LIB, undefined, testSqliteDb(handle.db))).toEqual([]);
  });
});

describe('findGeneratedSearchById', () => {
  test('resolves the collection the assets route was asked for', async () => {
    using handle = await createTestDatabase();
    const db = testSqliteDb(handle.db);
    await saveGeneratedSearches([input()], db);
    const [doc] = await listGeneratedSearches(LIB, '2026-08-17', db);

    const found = await findGeneratedSearchById(doc!._id, db);
    expect(found?.theme).toBe('golden hour');
    expect(found?.library_id).toBe(LIB);
  });

  test('returns null for an id that names nothing', async () => {
    using handle = await createTestDatabase();
    const db = testSqliteDb(handle.db);
    expect(await findGeneratedSearchById(new ObjectId(newObjectIdHex()), db)).toBeNull();
  });
});

describe('pruneGeneratedSearches', () => {
  test('removes only what is past the retention window and reports the count', async () => {
    using handle = await createTestDatabase();
    const db = testSqliteDb(handle.db);
    await saveGeneratedSearches(
      [
        input({ generated_at: '2026-06-01T00:00:00.000Z', theme: 'stale' }),
        input({ generated_at: '2026-06-02T00:00:00.000Z', theme: 'also stale' }),
        input({ generated_at: '2026-08-17T06:00:00.000Z', theme: 'fresh' }),
      ],
      db,
    );

    const removed = await pruneGeneratedSearches(30, new Date('2026-08-17T12:00:00.000Z'), db);
    expect(removed).toBe(2);
    const left = await listGeneratedSearches(LIB, '2026-08-17', db);
    expect(left.map((d) => d.theme)).toEqual(['fresh']);
  });

  test('reports zero when nothing is old enough', async () => {
    using handle = await createTestDatabase();
    const db = testSqliteDb(handle.db);
    await saveGeneratedSearches([input()], db);
    expect(await pruneGeneratedSearches(30, new Date('2026-08-17T12:00:00.000Z'), db)).toBe(0);
  });

  test('sweeps every library, not just one', async () => {
    using handle = await createTestDatabase();
    const db = testSqliteDb(handle.db);
    await saveGeneratedSearches(
      [
        input({ generated_at: '2026-06-01T00:00:00.000Z' }),
        input({ library_id: OTHER_LIB, generated_at: '2026-06-01T00:00:00.000Z' }),
      ],
      db,
    );
    expect(await pruneGeneratedSearches(30, new Date('2026-08-17T12:00:00.000Z'), db)).toBe(2);
  });
});
