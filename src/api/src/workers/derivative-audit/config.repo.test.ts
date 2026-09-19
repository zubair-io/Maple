import { describe, expect, it } from 'bun:test';
import { createLiveTestDatabase } from '../../db/sqlite/test-sqlite.test-helpers.ts';
import {
  loadDerivativeAuditConfig,
  saveDerivativeAuditConfig,
  DEFAULT_DERIVATIVE_AUDIT_CONFIG,
} from './config.repo.ts';

describe('derivative-audit config repo', () => {
  it('returns defaults when no doc exists', async () => {
    using _live = await createLiveTestDatabase();
    expect(await loadDerivativeAuditConfig()).toMatchObject(DEFAULT_DERIVATIVE_AUDIT_CONFIG);
  });

  it('round-trips a partial patch, leaving other fields at default', async () => {
    using _live = await createLiveTestDatabase();
    await saveDerivativeAuditConfig({ enabled: false, max_resets_per_pass: 25 });
    const cfg = await loadDerivativeAuditConfig();
    expect(cfg.enabled).toBe(false);
    expect(cfg.max_resets_per_pass).toBe(25);
    expect(cfg.deep_r2_enabled).toBe(DEFAULT_DERIVATIVE_AUDIT_CONFIG.deep_r2_enabled);
    expect(cfg.interval_ms).toBe(DEFAULT_DERIVATIVE_AUDIT_CONFIG.interval_ms);
  });
});
