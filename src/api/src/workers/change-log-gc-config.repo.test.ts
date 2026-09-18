import { describe, expect, it, beforeEach } from 'bun:test';
import { getDb } from '../db/client.ts';
import {
  clampRetentionDays,
  DEFAULT_RETENTION_DAYS,
  loadChangeLogRetentionDays,
  saveChangeLogRetentionDays,
  loadChangeLogGcConfig,
  saveChangeLogGcConfig,
  MIN_RETENTION_DAYS,
  MAX_RETENTION_DAYS,
} from './change-log-gc-config.repo.ts';

describe('change-log-gc-config.repo', () => {
  beforeEach(async () => {
    try {
      const db = await getDb();
      await db.collection('app_settings').deleteOne({ _id: 'change-log-gc' });
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
      const days = await loadChangeLogRetentionDays();
      expect(days).toBe(DEFAULT_RETENTION_DAYS);

      const cfg = await loadChangeLogGcConfig();
      expect(cfg.retention_days).toBe(DEFAULT_RETENTION_DAYS);
    });

    it('saves and loads configured retention window', async () => {
      const saved = await saveChangeLogRetentionDays(60);
      expect(saved).toBe(60);

      const loaded = await loadChangeLogRetentionDays();
      expect(loaded).toBe(60);

      const cfg = await loadChangeLogGcConfig();
      expect(cfg.retention_days).toBe(60);
    });

    it('patches config via saveChangeLogGcConfig', async () => {
      const updated = await saveChangeLogGcConfig({ retention_days: 90 });
      expect(updated.retention_days).toBe(90);

      const cfg = await loadChangeLogGcConfig();
      expect(cfg.retention_days).toBe(90);
    });
  });
});
