/**
 * Unit tests for the optional TLS bootstrap (#2415). Pure — no real server,
 * no real certs needed. `resolveTlsConfig` takes an env map, so these never
 * touch `process.env` itself (a leaked mutation there would bleed into
 * `index.ts`'s module-load-time `TLS_CONFIG` singleton for every other test
 * file in the same process).
 */

import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveTlsConfig } from './tls-config.ts';

describe('resolveTlsConfig', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'maple-tls-test-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('returns null when both MAPLE_TLS_CERT and MAPLE_TLS_KEY are unset', () => {
    expect(resolveTlsConfig({})).toBeNull();
  });

  it('returns null when both are set to empty/whitespace strings', () => {
    expect(resolveTlsConfig({ MAPLE_TLS_CERT: '  ', MAPLE_TLS_KEY: '' })).toBeNull();
  });

  it('throws when only MAPLE_TLS_CERT is set', () => {
    const cert = join(dir, 'cert.pem');
    writeFileSync(cert, 'cert bytes');
    expect(() => resolveTlsConfig({ MAPLE_TLS_CERT: cert })).toThrow(
      /MAPLE_TLS_CERT and MAPLE_TLS_KEY must both be set/,
    );
  });

  it('throws when only MAPLE_TLS_KEY is set', () => {
    const key = join(dir, 'key.pem');
    writeFileSync(key, 'key bytes');
    expect(() => resolveTlsConfig({ MAPLE_TLS_KEY: key })).toThrow(
      /MAPLE_TLS_CERT and MAPLE_TLS_KEY must both be set/,
    );
  });

  it('throws when both are set but the cert path does not exist', () => {
    const key = join(dir, 'key.pem');
    writeFileSync(key, 'key bytes');
    const missingCert = join(dir, 'does-not-exist.pem');
    expect(() =>
      resolveTlsConfig({ MAPLE_TLS_CERT: missingCert, MAPLE_TLS_KEY: key }),
    ).toThrow(/MAPLE_TLS_CERT=.*not a readable file/);
  });

  it('throws when both are set but the key path is unreadable', () => {
    const cert = join(dir, 'cert.pem');
    writeFileSync(cert, 'cert bytes');
    const key = join(dir, 'key.pem');
    writeFileSync(key, 'key bytes');
    chmodSync(key, 0o000);
    try {
      expect(() => resolveTlsConfig({ MAPLE_TLS_CERT: cert, MAPLE_TLS_KEY: key })).toThrow(
        /MAPLE_TLS_KEY=.*not a readable file/,
      );
    } finally {
      // Restore so the tmpdir cleanup in afterEach can delete it.
      chmodSync(key, 0o600);
    }
  });

  it('returns the validated paths when both are set and readable', () => {
    const cert = join(dir, 'cert.pem');
    const key = join(dir, 'key.pem');
    writeFileSync(cert, 'cert bytes');
    writeFileSync(key, 'key bytes');
    expect(resolveTlsConfig({ MAPLE_TLS_CERT: cert, MAPLE_TLS_KEY: key })).toEqual({
      certPath: cert,
      keyPath: key,
    });
  });

  it('trims surrounding whitespace from the configured paths', () => {
    const cert = join(dir, 'cert.pem');
    const key = join(dir, 'key.pem');
    writeFileSync(cert, 'cert bytes');
    writeFileSync(key, 'key bytes');
    expect(
      resolveTlsConfig({ MAPLE_TLS_CERT: `  ${cert}  `, MAPLE_TLS_KEY: `  ${key}  ` }),
    ).toEqual({ certPath: cert, keyPath: key });
  });
});
