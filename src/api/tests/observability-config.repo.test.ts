/**
 * observability-config.repo unit tests.
 *
 * `resolveObservabilityConfig` + `validateHttpUrl` are pure functions, so the
 * precedence + validation cases need no database at all. The load/save
 * round-trip goes through `readAppSettings` / `patchAppSettings`, which reach
 * `sqliteDb()` with no override, so those cases install a real SQLite database
 * as the process-wide handle for the length of each test.
 */

import { describe, it, expect } from 'bun:test';
import {
  loadObservabilityConfig,
  resolveObservabilityConfig,
  saveObservabilityConfig,
  validateHttpUrl,
  type ObservabilityConfig,
} from '../src/observability/observability-config.repo.ts';
import { createLiveTestDatabase } from '../src/db/sqlite/test-sqlite.test-helpers.ts';

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

// ── load/save round-trip against a real database ──────────────────────────
describe('loadObservabilityConfig / saveObservabilityConfig', () => {
  it('returns null when no row exists', async () => {
    using live = await createLiveTestDatabase();
    expect(await loadObservabilityConfig()).toBeNull();
  });

  it('round-trips a partial patch, preserving untouched fields', async () => {
    using live = await createLiveTestDatabase();
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
    using live = await createLiveTestDatabase();
    await saveObservabilityConfig({ ingestion_key: 'secret' });
    await saveObservabilityConfig({ ingestion_key: null });
    const loaded = await loadObservabilityConfig();
    expect(loaded!.ingestion_key).toBeNull();
  });
});
