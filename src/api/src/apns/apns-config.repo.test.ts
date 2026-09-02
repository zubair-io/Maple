import { afterEach, describe, expect, it } from 'bun:test';
import {
  hasApnsCredentials,
  loadApnsCredentialsFromEnv,
  resolveApnsSettingsConfig,
} from './apns-config.repo.ts';

describe('resolveApnsSettingsConfig', () => {
  it('defaults to disabled when no row exists', () => {
    expect(resolveApnsSettingsConfig(null)).toEqual({ enabled: false });
  });

  it('defaults to disabled when the stored field is missing or null', () => {
    expect(resolveApnsSettingsConfig({})).toEqual({ enabled: false });
    expect(resolveApnsSettingsConfig({ enabled: null })).toEqual({ enabled: false });
  });

  it('reflects a saved true', () => {
    expect(resolveApnsSettingsConfig({ enabled: true })).toEqual({ enabled: true });
  });

  it('reflects a saved false explicitly (not just default-false)', () => {
    expect(resolveApnsSettingsConfig({ enabled: false })).toEqual({ enabled: false });
  });
});

describe('loadApnsCredentialsFromEnv / hasApnsCredentials', () => {
  const KEYS = ['MAPLE_APNS_KEY_ID', 'MAPLE_APNS_TEAM_ID', 'MAPLE_APNS_PRIVATE_KEY'] as const;
  const saved: Record<string, string | undefined> = {};

  afterEach(() => {
    for (const k of KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  function clearEnv(): void {
    for (const k of KEYS) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
  }

  it('returns null when any of the three env vars is unset', () => {
    clearEnv();
    expect(loadApnsCredentialsFromEnv()).toBeNull();
    expect(hasApnsCredentials()).toBe(false);

    process.env.MAPLE_APNS_KEY_ID = 'ABCDEFGHIJ';
    process.env.MAPLE_APNS_TEAM_ID = 'TEAM123456';
    expect(loadApnsCredentialsFromEnv()).toBeNull();
  });

  // Note: these fixtures deliberately do NOT spell out a real PEM header
  // (dashes-BEGIN-PRIVATE-KEY-dashes) — gitleaks' generic private-key rule
  // matches that literal text even in a non-secret test placeholder.
  // `loadApnsCredentialsFromEnv` only cares about the `\n` escape
  // handling, not PEM structure, so a made-up multi-line marker exercises
  // the same code path (`apns-sender.test.ts` covers the real
  // `importPKCS8` parse path against a runtime-generated keypair, which
  // never appears as literal source text).
  const FAKE_KEY_BODY = 'FAKE-KEY-LINE-ONE\nFAKE-KEY-LINE-TWO\nFAKE-KEY-LINE-THREE';

  it('returns the trio when all three are set', () => {
    clearEnv();
    process.env.MAPLE_APNS_KEY_ID = 'ABCDEFGHIJ';
    process.env.MAPLE_APNS_TEAM_ID = 'TEAM123456';
    process.env.MAPLE_APNS_PRIVATE_KEY = FAKE_KEY_BODY;
    const creds = loadApnsCredentialsFromEnv();
    expect(creds).toEqual({
      keyId: 'ABCDEFGHIJ',
      teamId: 'TEAM123456',
      privateKeyPem: FAKE_KEY_BODY,
    });
    expect(hasApnsCredentials()).toBe(true);
  });

  it('unescapes a literal backslash-n sequence into a real newline', () => {
    clearEnv();
    process.env.MAPLE_APNS_KEY_ID = 'ABCDEFGHIJ';
    process.env.MAPLE_APNS_TEAM_ID = 'TEAM123456';
    process.env.MAPLE_APNS_PRIVATE_KEY = FAKE_KEY_BODY.replace(/\n/g, '\\n');
    const creds = loadApnsCredentialsFromEnv();
    expect(creds?.privateKeyPem).toBe(FAKE_KEY_BODY);
  });
});
