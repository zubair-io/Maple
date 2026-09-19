/**
 * `lens_profiles` — the table that replaced a GridFS bucket.
 *
 * The cases worth having are the ones the bucket used to answer: bytes come
 * back byte-identical at a size that needed chunking on MongoDB, re-importing
 * the same profile is a no-op rather than a second row, and an unknown digest
 * is an ordinary `null` rather than a throw.
 */

import { describe, expect, test } from 'bun:test';
import { blake3 } from '@noble/hashes/blake3.js';
import { createTestDatabase, testSqliteDb } from '../sqlite/test-sqlite.test-helpers.ts';
import { readLensProfileBytes, saveLensProfileBytes } from './lens-profiles.repo.ts';

const INVENTORY = {
  version: 1,
  reference: 'lcp1:' + 'a'.repeat(64),
  name: 'Synthetic',
  make: 'Maple',
  camera: 'Test',
  lens: 'Prime',
  sampleCount: 1,
};

function digestOf(bytes: Uint8Array): string {
  return Buffer.from(blake3(bytes)).toString('hex');
}

/** Pseudo-random but deterministic, so a byte-for-byte comparison means something. */
function profileBytes(length: number, seed: number): Uint8Array {
  const bytes = new Uint8Array(length);
  for (let i = 0; i < length; i++) bytes[i] = (i * 31 + seed) % 256;
  return bytes;
}

describe('saveLensProfileBytes', () => {
  test('round-trips a profile byte for byte', async () => {
    using handle = await createTestDatabase();
    const db = testSqliteDb(handle.db);
    const bytes = profileBytes(4096, 7);
    const digest = digestOf(bytes);

    expect(await saveLensProfileBytes(digest, bytes, INVENTORY, db)).toBe(true);

    const read = await readLensProfileBytes(digest, db);
    expect(read).not.toBeNull();
    expect(read!.length).toBe(bytes.length);
    expect(Buffer.from(read!).equals(Buffer.from(bytes))).toBe(true);
    expect(digestOf(read!)).toBe(digest);
  });

  /**
   * 17 MiB is over MongoDB's 16 MiB document ceiling, which is the entire
   * reason this was a GridFS bucket. The same file is now one column, so the
   * size that used to force chunking is the size worth proving still survives.
   */
  test('stores a profile larger than the document ceiling GridFS existed for', async () => {
    using handle = await createTestDatabase();
    const db = testSqliteDb(handle.db);
    const bytes = profileBytes(17 * 1024 * 1024, 3);
    const digest = digestOf(bytes);

    await saveLensProfileBytes(digest, bytes, INVENTORY, db);

    const read = await readLensProfileBytes(digest, db);
    expect(read!.length).toBe(bytes.length);
    expect(digestOf(read!)).toBe(digest);
  });

  test('re-importing the same profile keeps one row and reports it did not store', async () => {
    using handle = await createTestDatabase();
    const db = testSqliteDb(handle.db);
    const bytes = profileBytes(512, 1);
    const digest = digestOf(bytes);

    expect(await saveLensProfileBytes(digest, bytes, INVENTORY, db)).toBe(true);
    expect(await saveLensProfileBytes(digest, bytes, INVENTORY, db)).toBe(false);

    expect(handle.db.query(`SELECT COUNT(*) AS n FROM lens_profiles`).get()).toEqual({ n: 1 });
  });

  test('stores the inventory as readable JSON', async () => {
    using handle = await createTestDatabase();
    const db = testSqliteDb(handle.db);
    const bytes = profileBytes(64, 2);
    const digest = digestOf(bytes);

    await saveLensProfileBytes(digest, bytes, INVENTORY, db);

    const row = handle.db
      .query(`SELECT inventory FROM lens_profiles WHERE digest = ?`)
      .get(digest) as { inventory: string };
    expect(JSON.parse(row.inventory)).toEqual(INVENTORY);
  });

  test('refuses a digest that is not 64 characters', async () => {
    using handle = await createTestDatabase();
    const db = testSqliteDb(handle.db);
    await expect(saveLensProfileBytes('abc', new Uint8Array([1]), INVENTORY, db)).rejects.toThrow(
      /CHECK constraint failed/,
    );
  });
});

describe('readLensProfileBytes', () => {
  test('answers null for a profile this server does not hold', async () => {
    using handle = await createTestDatabase();
    expect(await readLensProfileBytes('0'.repeat(64), testSqliteDb(handle.db))).toBeNull();
  });
});
