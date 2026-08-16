/**
 * ffi-pool-config repo tests — pure resolver precedence + clamp, plus a
 * real-Mongo round-trip. Skip-passes when MongoDB is unreachable (mirrors the
 * enrichment-config repo test).
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'bun:test';
import { MongoClient, type Db } from 'mongodb';
import {
  DEFAULT_FFI_WORKERS,
  MAX_FFI_WORKERS,
  MIN_FFI_WORKERS,
  clampFfiWorkers,
  loadPerformanceConfig,
  resolveFfiPoolConfig,
  savePerformanceConfig,
} from './ffi-pool-config.repo.ts';
import { withTestDb } from '../db/test-db.test-helpers.ts';

describe('clampFfiWorkers', () => {
  it('clamps below MIN up to MIN', () => {
    expect(clampFfiWorkers(0)).toBe(MIN_FFI_WORKERS);
    expect(clampFfiWorkers(-3)).toBe(MIN_FFI_WORKERS);
  });
  it('clamps above MAX down to MAX', () => {
    expect(clampFfiWorkers(99)).toBe(MAX_FFI_WORKERS);
  });
  it('floors fractional values', () => {
    expect(clampFfiWorkers(3.9)).toBe(3);
  });
  it('returns null for non-finite input', () => {
    expect(clampFfiWorkers(Number.NaN)).toBeNull();
    expect(clampFfiWorkers(Number.POSITIVE_INFINITY)).toBeNull();
  });
});

describe('resolveFfiPoolConfig — precedence', () => {
  it('defaults to 1 when no DB row and no env var', () => {
    const r = resolveFfiPoolConfig(null, {});
    expect(r.ffi_workers).toBe(DEFAULT_FFI_WORKERS);
    expect(r.ffi_workers).toBe(1);
    expect(r.source.ffi_workers).toBe('default');
  });

  it('uses env var when there is no DB row', () => {
    const r = resolveFfiPoolConfig(null, { MAPLE_FFI_WORKERS: '4' });
    expect(r.ffi_workers).toBe(4);
    expect(r.source.ffi_workers).toBe('env');
  });

  it('clamps the env var into range', () => {
    expect(resolveFfiPoolConfig(null, { MAPLE_FFI_WORKERS: '999' }).ffi_workers).toBe(
      MAX_FFI_WORKERS,
    );
    expect(resolveFfiPoolConfig(null, { MAPLE_FFI_WORKERS: '0' }).ffi_workers).toBe(
      MIN_FFI_WORKERS,
    );
  });

  it('ignores a non-numeric env var (falls back to default)', () => {
    const r = resolveFfiPoolConfig(null, { MAPLE_FFI_WORKERS: 'banana' });
    expect(r.ffi_workers).toBe(DEFAULT_FFI_WORKERS);
    expect(r.source.ffi_workers).toBe('default');
  });

  it('DB row wins over env var', () => {
    const r = resolveFfiPoolConfig({ ffi_workers: 8 }, { MAPLE_FFI_WORKERS: '2' });
    expect(r.ffi_workers).toBe(8);
    expect(r.source.ffi_workers).toBe('db');
  });

  it('clamps the DB value into range', () => {
    expect(resolveFfiPoolConfig({ ffi_workers: 50 }, {}).ffi_workers).toBe(MAX_FFI_WORKERS);
    expect(resolveFfiPoolConfig({ ffi_workers: -1 }, {}).ffi_workers).toBe(MIN_FFI_WORKERS);
  });

  it('falls back to env when the DB field is null/missing', () => {
    const r = resolveFfiPoolConfig({ ffi_workers: null }, { MAPLE_FFI_WORKERS: '3' });
    expect(r.ffi_workers).toBe(3);
    expect(r.source.ffi_workers).toBe('env');
  });
});

// ── Real-Mongo round-trip ────────────────────────────────────────────────
const TEST_DB = withTestDb(`maple_test_ffi_pool_cfg_${process.pid}`);
const MONGO_URI = process.env.MAPLE_MONGO_URI ?? 'mongodb://localhost:27017';

let mongo: MongoClient | null = null;
let mongoReachable = false;
let db: Db | null = null;

async function tryConnect(): Promise<MongoClient | null> {
  const c = new MongoClient(MONGO_URI, {
    serverSelectionTimeoutMS: 1500,
    connectTimeoutMS: 1500,
  });
  try {
    await c.connect();
    await c.db('admin').command({ ping: 1 });
    return c;
  } catch {
    try {
      await c.close();
    } catch {}
    return null;
  }
}

beforeAll(async () => {
  mongo = await tryConnect();
  mongoReachable = mongo !== null;
  if (!mongoReachable) {
    console.log('[ffi-pool-config.test] skipping DB round-trip: MongoDB unreachable');
    return;
  }
  db = mongo!.db(TEST_DB);
  await db.dropDatabase();
  const { closeDb } = await import('../db/client.ts');
  await closeDb();
});

beforeEach(async () => {
  if (!mongoReachable) return;
  await db!.collection('app_settings').deleteMany({});
});

afterAll(async () => {
  if (mongo) {
    await mongo.db(TEST_DB).dropDatabase();
    await mongo.close();
  }
  const { closeDb } = await import('../db/client.ts');
  await closeDb();
});

describe('performance config — Mongo round-trip', () => {
  it('returns null before any row is written', async () => {
    if (!mongoReachable) return;
    expect(await loadPerformanceConfig()).toBeNull();
  });

  it('round-trips a saved ffi_workers value (DB overrides env)', async () => {
    if (!mongoReachable) return;
    await savePerformanceConfig({ ffi_workers: 6 });
    const loaded = await loadPerformanceConfig();
    expect(loaded?.ffi_workers).toBe(6);
    const resolved = resolveFfiPoolConfig(loaded, { MAPLE_FFI_WORKERS: '2' });
    expect(resolved.ffi_workers).toBe(6);
    expect(resolved.source.ffi_workers).toBe('db');
  });

  it('partial patch preserves the document and overwrites the field', async () => {
    if (!mongoReachable) return;
    await savePerformanceConfig({ ffi_workers: 3 });
    await savePerformanceConfig({ ffi_workers: 5 });
    const loaded = await loadPerformanceConfig();
    expect(loaded?.ffi_workers).toBe(5);
    expect(typeof loaded?.updated_at).toBe('number');
  });
});
