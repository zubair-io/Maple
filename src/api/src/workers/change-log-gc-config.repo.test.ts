import { describe, expect, it } from 'bun:test';
import {
  clampRetentionDays,
  DEFAULT_RETENTION_DAYS,
  loadChangeLogGcConfig,
  saveChangeLogGcConfig,
  recordChangeLogGcRun,
  MIN_RETENTION_DAYS,
  MAX_RETENTION_DAYS,
} from './change-log-gc-config.repo.ts';
import { createTestDatabase, testSqliteDb } from '../db/sqlite/test-sqlite.test-helpers.ts';

describe('change-log-gc-config.repo', () => {
  describe('clampRetentionDays', () => {
    it('clamps below minimum to MIN_RETENTION_DAYS', () => {
      expect(clampRetentionDays(0)).toBe(MIN_RETENTION_DAYS);
      expect(clampRetentionDays(-10)).toBe(MIN_RETENTION_DAYS);
    });

    it('clamps above maximum to MAX_RETENTION_DAYS', () => {
      expect(clampRetentionDays(99999)).toBe(MAX_RETENTION_DAYS);
    });

    it('falls back to default for non-finite values', () => {
      expect(clampRetentionDays(NaN)).toBe(DEFAULT_RETENTION_DAYS);
      expect(clampRetentionDays(Infinity)).toBe(DEFAULT_RETENTION_DAYS);
    });

    it('rounds floating-point days', () => {
      expect(clampRetentionDays(14.6)).toBe(15);
    });
  });

  // Every persistence case drives the repo through its `dbOverride` tail
  // parameter, which is the same one `runChangeLogGcOnce` forwards.
  describe('persistence', () => {
    it('returns default when no doc exists', async () => {
      using handle = await createTestDatabase();
      const cfg = await loadChangeLogGcConfig(testSqliteDb(handle.db));
      expect(cfg.enabled).toBe(true);
      expect(cfg.retention_days).toBe(DEFAULT_RETENTION_DAYS);
      expect(cfg.last_run).toBeNull();
    });

    it('saves and loads configured retention window', async () => {
      using handle = await createTestDatabase();
      const db = testSqliteDb(handle.db);
      const saved = await saveChangeLogGcConfig({ retention_days: 60 }, db);
      expect(saved.retention_days).toBe(60);

      const cfg = await loadChangeLogGcConfig(db);
      expect(cfg.retention_days).toBe(60);
    });

    it('patches enabled flag and preserves retention_days', async () => {
      using handle = await createTestDatabase();
      const db = testSqliteDb(handle.db);
      await saveChangeLogGcConfig({ retention_days: 45 }, db);
      const updated = await saveChangeLogGcConfig({ enabled: false }, db);
      expect(updated.enabled).toBe(false);
      expect(updated.retention_days).toBe(45);

      const cfg = await loadChangeLogGcConfig(db);
      expect(cfg.enabled).toBe(false);
      expect(cfg.retention_days).toBe(45);
    });

    it('records and loads last_run summary', async () => {
      using handle = await createTestDatabase();
      const db = testSqliteDb(handle.db);
      const run = {
        deleted: 1500,
        batches: 3,
        duration_ms: 120,
        pruned_through: 5000,
        remaining: 200,
        finished_at: new Date().toISOString(),
      };
      await recordChangeLogGcRun(run, db);

      const cfg = await loadChangeLogGcConfig(db);
      expect(cfg.last_run).toEqual(run);
    });
  });
});
