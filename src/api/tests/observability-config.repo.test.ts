/**
 * observability-config.repo unit tests.
 *
 * `resolveObservabilityConfig` + `validateHttpUrl` are pure functions — no
 * Mongo required, so the precedence + validation cases run everywhere. The
 * load/save round-trip is Mongo-gated and skip-passes when Mongo is
 * unreachable (per-test DB named with `process.pid`, mirroring the other
 * repo + route tests).
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'bun:test';
import { MongoClient, type Db } from 'mongodb';
import {
  resolveObservabilityConfig,
  validateHttpUrl,
  type ObservabilityConfig,
} from '../src/observability/observability-config.repo.ts';
import { withTestDb } from '../src/db/test-db.test-helpers.ts';

describe('resolveObservabilityConfig — defaults (no db row)', () => {
  it('returns the documented defaults', () => {
    const r = resolveObservabilityConfig(null);
    expect(r.enabled).toBe(true);
    expect(r.endpoint).toBeNull();
    expect(r.ingestion_key).toBeNull();
    expect(r.service_namespace).toBe('maple');
    expect(r.traces_enabled).toBe(true);
    expect(r.logs_enabled).toBe(true);
    expect(r.metrics_enabled).toBe(false);
    expect(r.sample_ratio).toBe(1.0);
    expect(r.source).toMatchObject({
      enabled: 'default',
      endpoint: 'unset',
      ingestion_key: 'unset',
      service_namespace: 'default',
      traces_enabled: 'default',
      logs_enabled: 'default',
      metrics_enabled: 'default',
      sample_ratio: 'default',
    });
  });
});

describe('resolveObservabilityConfig — db is the only source (db > default)', () => {
  it('reads every field from the db row, stripping a trailing slash on the endpoint', () => {
    const db: ObservabilityConfig = {
      enabled: false,
      endpoint: 'https://from-db.test:4318/',
      ingestion_key: 'db-key',
      service_namespace: 'from-db-ns',
      traces_enabled: false,
      logs_enabled: true,
      metrics_enabled: true,
      sample_ratio: 0.1,
    };
    const r = resolveObservabilityConfig(db);
    expect(r.enabled).toBe(false);
    expect(r.source.enabled).toBe('db');
    expect(r.endpoint).toBe('https://from-db.test:4318');
    expect(r.source.endpoint).toBe('db');
    expect(r.ingestion_key).toBe('db-key');
    expect(r.source.ingestion_key).toBe('db');
    expect(r.service_namespace).toBe('from-db-ns');
    expect(r.source.service_namespace).toBe('db');
    expect(r.traces_enabled).toBe(false);
    expect(r.source.traces_enabled).toBe('db');
    expect(r.metrics_enabled).toBe(true);
    expect(r.source.metrics_enabled).toBe('db');
    expect(r.sample_ratio).toBe(0.1);
    expect(r.source.sample_ratio).toBe('db');
  });

  it('falls through to defaults for fields the db row omits', () => {
    // Only `enabled` set; every other field resolves to its built-in default.
    const r = resolveObservabilityConfig({ enabled: false });
    expect(r.enabled).toBe(false);
    expect(r.source.enabled).toBe('db');
    expect(r.endpoint).toBeNull();
    expect(r.source.endpoint).toBe('unset');
    expect(r.ingestion_key).toBeNull();
    expect(r.source.ingestion_key).toBe('unset');
    expect(r.service_namespace).toBe('maple');
    expect(r.source.service_namespace).toBe('default');
    expect(r.sample_ratio).toBe(1.0);
    expect(r.source.sample_ratio).toBe('default');
  });

  it('ignores an out-of-range db sample ratio, falling through to default', () => {
    const r = resolveObservabilityConfig({ sample_ratio: 2 });
    expect(r.sample_ratio).toBe(1.0);
    expect(r.source.sample_ratio).toBe('default');
  });

  it('ignores a blank/whitespace db endpoint (resolves to unset)', () => {
    const r = resolveObservabilityConfig({ endpoint: '   ' });
    expect(r.endpoint).toBeNull();
    expect(r.source.endpoint).toBe('unset');
  });

  it('accepts boundary sample ratios 0 and 1 from the db', () => {
    expect(resolveObservabilityConfig({ sample_ratio: 0 }).sample_ratio).toBe(0);
    expect(resolveObservabilityConfig({ sample_ratio: 1 }).sample_ratio).toBe(1);
  });
});

describe('validateHttpUrl', () => {
  it('accepts http and https and strips trailing slashes', () => {
    expect(validateHttpUrl('http://a.test:4318/')).toBe('http://a.test:4318');
    expect(validateHttpUrl('https://a.test///')).toBe('https://a.test');
  });

  it('returns null for null / empty / whitespace input', () => {
    expect(validateHttpUrl(null)).toBeNull();
    expect(validateHttpUrl('')).toBeNull();
    expect(validateHttpUrl('   ')).toBeNull();
  });

  it('rejects non-http(s) protocols', () => {
    const r = validateHttpUrl('file:///etc/passwd');
    expect(r).toMatchObject({ error: expect.stringMatching(/protocol/i) });
  });

  it('rejects an unparseable URL', () => {
    const r = validateHttpUrl('not a url');
    expect(r).toMatchObject({ error: expect.any(String) });
  });
});

// ── Mongo-gated load/save round-trip ──────────────────────────────────────
const TEST_DB = withTestDb(`maple_test_observability_repo_${process.pid}`);
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

describe('loadObservabilityConfig / saveObservabilityConfig (Mongo)', () => {
  beforeAll(async () => {
    mongo = await tryConnect();
    mongoReachable = mongo !== null;
    if (!mongoReachable) {
      console.log(
        '[observability-config.repo.test] skipping Mongo round-trip: MongoDB unreachable',
      );
      return;
    }
    db = mongo!.db(TEST_DB);
    await db.dropDatabase();
    const { closeDb } = await import('../src/db/client.ts');
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
    const { closeDb } = await import('../src/db/client.ts');
    await closeDb();
  });

  it('returns null when no row exists', async () => {
    if (!mongoReachable) return;
    const { loadObservabilityConfig } =
      await import('../src/observability/observability-config.repo.ts');
    expect(await loadObservabilityConfig()).toBeNull();
  });

  it('round-trips a partial patch, preserving untouched fields', async () => {
    if (!mongoReachable) return;
    const { loadObservabilityConfig, saveObservabilityConfig } =
      await import('../src/observability/observability-config.repo.ts');
    await saveObservabilityConfig({ endpoint: 'https://a.test', ingestion_key: 'k1' });
    // A second patch touching only `enabled` must not clobber endpoint/key.
    await saveObservabilityConfig({ enabled: false });
    const loaded = await loadObservabilityConfig();
    expect(loaded).toMatchObject({
      endpoint: 'https://a.test',
      ingestion_key: 'k1',
      enabled: false,
    });
    expect(typeof loaded!.updated_at).toBe('number');
  });

  it('clears a field to null when null is saved', async () => {
    if (!mongoReachable) return;
    const { loadObservabilityConfig, saveObservabilityConfig } =
      await import('../src/observability/observability-config.repo.ts');
    await saveObservabilityConfig({ ingestion_key: 'secret' });
    await saveObservabilityConfig({ ingestion_key: null });
    const loaded = await loadObservabilityConfig();
    expect(loaded!.ingestion_key).toBeNull();
  });
});
