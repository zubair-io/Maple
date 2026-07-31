/**
 * Unit tests for the optional TLS bootstrap (#2415). Pure — no real server,
 * no real certs needed. `resolveTlsConfig` takes an env map, so these never
 * touch `process.env` itself (a leaked mutation there would bleed into
 * `index.ts`'s module-load-time TLS singleton for every other test file in
 * the same process).
 */

import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
// Raw node:fs is allowlisted in .oxlintrc.json for this file: tmpdir-only
// fixture staging for the read-only TLS bootstrap under test.
import { mkdtempSync, rmSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveTlsConfig, listenOptions } from './tls-config.ts';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'maple-tls-test-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** Writes a throwaway cert/key file pair into the suite tmpdir. */
function writePair(): { cert: string; key: string } {
  const cert = join(dir, 'cert.pem');
  const key = join(dir, 'key.pem');
  writeFileSync(cert, 'cert bytes');
  writeFileSync(key, 'key bytes');
  return { cert, key };
}

describe('resolveTlsConfig — misconfiguration fails fast', () => {
  it('returns null when both MAPLE_TLS_CERT and MAPLE_TLS_KEY are unset', () => {
    expect(resolveTlsConfig({})).toBeNull();
  });

  it('returns null when both are set to empty/whitespace strings', () => {
    expect(resolveTlsConfig({ MAPLE_TLS_CERT: '  ', MAPLE_TLS_KEY: '' })).toBeNull();
  });

  it('throws when only MAPLE_TLS_CERT is set', () => {
    const { cert } = writePair();
    expect(() => resolveTlsConfig({ MAPLE_TLS_CERT: cert })).toThrow(
      /MAPLE_TLS_CERT and MAPLE_TLS_KEY must both be set/,
    );
  });

  it('throws when only MAPLE_TLS_KEY is set', () => {
    const { key } = writePair();
    expect(() => resolveTlsConfig({ MAPLE_TLS_KEY: key })).toThrow(
      /MAPLE_TLS_CERT and MAPLE_TLS_KEY must both be set/,
    );
  });

  it('throws when both are set but the cert path does not exist', () => {
    const { key } = writePair();
    const missingCert = join(dir, 'does-not-exist.pem');
    expect(() => resolveTlsConfig({ MAPLE_TLS_CERT: missingCert, MAPLE_TLS_KEY: key })).toThrow(
      /MAPLE_TLS_CERT=.*not a readable file/,
    );
  });

  it('throws when both are set but the key path is unreadable', () => {
    const { cert, key } = writePair();
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
});

describe('resolveTlsConfig — valid configuration', () => {
  it('returns the validated paths when both are set and readable', () => {
    const { cert, key } = writePair();
    expect(resolveTlsConfig({ MAPLE_TLS_CERT: cert, MAPLE_TLS_KEY: key })).toEqual({
      certPath: cert,
      keyPath: key,
    });
  });

  it('trims surrounding whitespace from the configured paths', () => {
    const { cert, key } = writePair();
    expect(
      resolveTlsConfig({
        MAPLE_TLS_CERT: `  ${cert}  `,
        MAPLE_TLS_KEY: `  ${key}  `,
      }),
    ).toEqual({ certPath: cert, keyPath: key });
  });
});

describe('listenOptions', () => {
  // `listenOptions` reads the module-load-time TLS singleton (real
  // `process.env`, not injectable) — this process never sets MAPLE_TLS_CERT/
  // MAPLE_TLS_KEY, so only the "TLS unconfigured" branch is exercisable here.
  // The "TLS configured" branch is the same object-literal shape `resolveTlsConfig`
  // already proves valid above; `network.scheme.test.ts` covers the derived
  // `TLS_ENABLED` flag that the rest of the app (the /local-address route) reads.
  it('passes the bare port through when TLS is unconfigured', () => {
    expect(listenOptions(4321)).toBe(4321);
  });
});
