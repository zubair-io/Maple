import { describe, expect, it } from 'bun:test';
import { buildStageReset, auditMarkKey, AUDIT_MAX_ATTEMPTS } from './reset.ts';

describe('buildStageReset', () => {
  it('emits exactly the five re-arm fields for the stage', () => {
    expect(buildStageReset('thumb')).toEqual({
      'stages.thumb.version': 0,
      'stages.thumb.attempts': 0,
      'stages.thumb.last_error': null,
      'stages.thumb.processed_at': null,
      'stages.thumb.dead': false,
    });
  });
});

describe('auditMarkKey', () => {
  it('namespaces under derivative_audit', () => {
    expect(auditMarkKey('cf-thumb-sync')).toBe('derivative_audit.cf-thumb-sync');
  });
});

describe('AUDIT_MAX_ATTEMPTS', () => {
  it('is a small positive bound', () => {
    expect(AUDIT_MAX_ATTEMPTS).toBeGreaterThan(0);
    expect(AUDIT_MAX_ATTEMPTS).toBeLessThanOrEqual(5);
  });
});
