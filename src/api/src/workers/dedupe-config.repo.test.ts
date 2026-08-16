/**
 * DeDuplicate config repo. The clamp is pure (always runs); the load/save
 * round-trip is Mongo-gated (skip-pass when unreachable).
 */

import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import { MongoClient } from 'mongodb';
import { clampBatchSize, DEFAULT_BATCH_SIZE } from './dedupe-config.repo.ts';
import { withTestDb } from '../db/test-db.test-helpers.ts';

describe('clampBatchSize', () => {
  it('keeps an in-range value, rounding floats', () => {
    expect(clampBatchSize(200)).toBe(200);
    expect(clampBatchSize(12.7)).toBe(13);
  });
  it('clamps to [1, 5000]', () => {
    expect(clampBatchSize(0)).toBe(1);
    expect(clampBatchSize(-50)).toBe(1);
    expect(clampBatchSize(999999)).toBe(5000);
  });
  it('falls back to the default for non-finite input', () => {
    expect(clampBatchSize(NaN)).toBe(DEFAULT_BATCH_SIZE);
    expect(clampBatchSize(Infinity)).toBe(DEFAULT_BATCH_SIZE); // non-finite → default, not clamped
  });
});

const TEST_DB = withTestDb(`maple_test_dedupecfg_${process.pid}`);
const MONGO_URI = process.env.MAPLE_MONGO_URI ?? 'mongodb://localhost:27017';

let mongo: MongoClient | null = null;
let reachable = false;

beforeAll(async () => {
  const c = new MongoClient(MONGO_URI, { serverSelectionTimeoutMS: 1500, connectTimeoutMS: 1500 });
  try {
    await c.connect();
    await c.db('admin').command({ ping: 1 });
    mongo = c;
    reachable = true;
  } catch {
    await c.close().catch(() => undefined);
    console.log('[dedupe-config.test] skipping DB round-trip: MongoDB unreachable');
  }
});

afterAll(async () => {
  if (mongo) {
    await mongo.db(TEST_DB).dropDatabase();
    await mongo.close();
  }
  const { closeDb } = await import('../db/client.ts');
  await closeDb();
});

describe('load/save round-trip', () => {
  it('defaults when no doc exists, then persists a partial patch', async () => {
    if (!reachable) return;
    const { loadDeDuplicateConfig, saveDeDuplicateConfig } =
      await import('./dedupe-config.repo.ts');

    const def = await loadDeDuplicateConfig();
    expect(def).toEqual({ batch_size: DEFAULT_BATCH_SIZE, dry_run: false });

    const saved = await saveDeDuplicateConfig({ dry_run: true });
    expect(saved.dry_run).toBe(true);
    expect(saved.batch_size).toBe(DEFAULT_BATCH_SIZE); // untouched field keeps default

    const reread = await loadDeDuplicateConfig();
    expect(reread.dry_run).toBe(true);

    const clamped = await saveDeDuplicateConfig({ batch_size: 99999 });
    expect(clamped.batch_size).toBe(5000); // clamped on write
    expect(clamped.dry_run).toBe(true); // prior field preserved
  });
});
