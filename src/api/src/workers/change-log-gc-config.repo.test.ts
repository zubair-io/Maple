import { describe, expect, it, beforeEach } from 'bun:test';
import { getDb } from '../db/client.ts';
import {
  clampRetentionDays,
  DEFAULT_RETENTION_DAYS,
  loadChangeLogGcConfig,
  saveChangeLogGcConfig,
  recordChangeLogGcRun,
  MIN_RETENTION_DAYS,
  MAX_RETENTION_DAYS,
} from './change-log-gc-config.repo.ts';

describe('change-log-gc-config.repo', () => {
  beforeEach(async () => {
    try {
      const db = await getDb();
      await db.collection('app_settings').deleteOne({ _id: 'change-log-gc' as never });
    } catch {
      // Ignore if DB is unreachable in pure unit runs
    }
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
  });
});
