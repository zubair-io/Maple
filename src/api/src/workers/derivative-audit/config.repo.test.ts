import { describe, expect, it } from 'bun:test';
import { setupAuditMongo } from './test-support.ts';
import {
  loadDerivativeAuditConfig,
  saveDerivativeAuditConfig,
  DEFAULT_DERIVATIVE_AUDIT_CONFIG,
} from './config.repo.ts';

const h = setupAuditMongo(`maple_derivative_audit_config_test_${process.pid}`);

describe('derivative-audit config repo', () => {
  it('returns defaults when no doc exists', async () => {
    if (!h.mongoReachable) return;
    expect(await loadDerivativeAuditConfig()).toMatchObject(DEFAULT_DERIVATIVE_AUDIT_CONFIG);
  });

  it('round-trips a partial patch, leaving other fields at default', async () => {
    if (!h.mongoReachable) return;
    await saveDerivativeAuditConfig({ enabled: false, max_resets_per_pass: 25 });
    const cfg = await loadDerivativeAuditConfig();
    expect(cfg.enabled).toBe(false);
    expect(cfg.max_resets_per_pass).toBe(25);
    expect(cfg.deep_r2_enabled).toBe(DEFAULT_DERIVATIVE_AUDIT_CONFIG.deep_r2_enabled);
    expect(cfg.interval_ms).toBe(DEFAULT_DERIVATIVE_AUDIT_CONFIG.interval_ms);
  });
});
