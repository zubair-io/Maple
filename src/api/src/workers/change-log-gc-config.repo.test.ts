import { describe, expect, it, beforeAll, beforeEach } from 'bun:test';
import { closeDb, getDb } from '../db/client.ts';
import { withTestDb } from '../db/test-db.test-helpers.ts';
import type { Db } from 'mongodb';
import {
  clampRetentionDays,
  DEFAULT_RETENTION_DAYS,
  loadChangeLogGcConfig,
  saveChangeLogGcConfig,
  recordChangeLogGcRun,
  MIN_RETENTION_DAYS,
  MAX_RETENTION_DAYS,
} from './change-log-gc-config.repo.ts';

// Writes to `app_settings`; keep it off the default `maple` database so a local
// run can't overwrite the developer's real worker settings (#2783).
withTestDb(`maple_test_change_log_gc_config_${process.pid}`);

describe('change-log-gc-config.repo', () => {
  beforeAll(async () => {
    await closeDb();
  });

  beforeEach(async () => {
    const db = await getDb();
    await db.collection('app_settings').deleteOne({ _id: 'change-log-gc' as never });
  });

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

  describe('persistence', () => {
    it('returns default when no doc exists', async () => {
      const cfg = await loadChangeLogGcConfig();
      expect(cfg.enabled).toBe(true);
      expect(cfg.retention_days).toBe(DEFAULT_RETENTION_DAYS);
      expect(cfg.last_run).toBeNull();
    });

    it('saves and loads configured retention window', async () => {
      const saved = await saveChangeLogGcConfig({ retention_days: 60 });
      expect(saved.retention_days).toBe(60);

      const cfg = await loadChangeLogGcConfig();
      expect(cfg.retention_days).toBe(60);
    });

    it('patches enabled flag and preserves retention_days', async () => {
      await saveChangeLogGcConfig({ retention_days: 45 });
      const updated = await saveChangeLogGcConfig({ enabled: false });
      expect(updated.enabled).toBe(false);
      expect(updated.retention_days).toBe(45);

      const cfg = await loadChangeLogGcConfig();
      expect(cfg.enabled).toBe(false);
      expect(cfg.retention_days).toBe(45);
    });

    it('records and loads last_run summary', async () => {
      const run = {
        deleted: 1500,
        batches: 3,
        duration_ms: 120,
        pruned_through: 5000,
        remaining: 200,
        finished_at: new Date().toISOString(),
      };
      await recordChangeLogGcRun(run);

      const cfg = await loadChangeLogGcConfig();
      expect(cfg.last_run).toEqual(run);
    });

    // "No document" and "couldn't read the document" are different answers.
    // The first is an operator who never touched the setting, so the defaults
    // are their config. The second must reach the caller, because the caller
    // deletes rows for a living and has to be able to stand down.
    it('propagates a read failure instead of answering with the defaults', async () => {
      const unreadable = {
        collection: () => ({
          findOne: () => Promise.reject(new Error('connection timed out')),
        }),
      } as unknown as Db;

      await expect(loadChangeLogGcConfig(unreadable)).rejects.toThrow('connection timed out');
    });
  });
});
