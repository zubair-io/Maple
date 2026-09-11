/**
 * Browser origin allowlist (#3519). The managed LAN HTTPS hostname is a
 * runtime setting, so it must reach the WebAuthn and WebSocket gates without
 * an operator editing `MAPLE_ORIGIN` and redeploying.
 *
 * `withTestEnv` claims MAPLE_ORIGIN in `beforeAll` and restores it in
 * `afterAll` (#2900). Capturing it at module scope instead would record
 * whichever sibling suite imported last, since Bun evaluates every module body
 * before any test runs — the #2783 flake class. Individual tests reassign the
 * variable freely inside that window; the helper reads it per call.
 */
import { afterAll, afterEach, describe, expect, it, spyOn } from 'bun:test';
import { managedHttps } from '../network/managed-https.ts';
import { withTestEnv } from '../db/test-db.test-helpers.ts';
import { allowedBrowserOrigins, managedHttpsOrigin } from './allowed-origins.ts';

withTestEnv('MAPLE_ORIGIN', 'https://maple.example.com');

const endpoint = spyOn(managedHttps, 'endpoint');

afterEach(() => endpoint.mockReset());
afterAll(() => endpoint.mockRestore());

describe('allowed browser origins', () => {
  it('returns only the configured origins while no certificate is serving', () => {
    process.env.MAPLE_ORIGIN = 'https://maple.example.com';
    endpoint.mockReturnValue(null);
    expect(allowedBrowserOrigins()).toEqual(['https://maple.example.com']);
    expect(managedHttpsOrigin()).toBeNull();
  });

  it('adds the managed hostname without a port when it serves on 443', () => {
    process.env.MAPLE_ORIGIN = 'https://maple.example.com';
    endpoint.mockReturnValue({ ip: 'local.maple.example.com', port: 443, scheme: 'https' });
    // A browser omits the scheme-default port, so `:443` would never match.
    expect(allowedBrowserOrigins()).toEqual([
      'https://maple.example.com',
      'https://local.maple.example.com',
    ]);
  });

  it('keeps a non-default port, which the browser does send', () => {
    process.env.MAPLE_ORIGIN = 'https://maple.example.com';
    endpoint.mockReturnValue({ ip: 'local.maple.example.com', port: 3443, scheme: 'https' });
    expect(allowedBrowserOrigins()).toContain('https://local.maple.example.com:3443');
  });

  it('does not duplicate a hostname MAPLE_ORIGIN already lists', () => {
    process.env.MAPLE_ORIGIN = 'https://maple.example.com, https://local.maple.example.com';
    endpoint.mockReturnValue({ ip: 'local.maple.example.com', port: 443, scheme: 'https' });
    expect(allowedBrowserOrigins()).toEqual([
      'https://maple.example.com',
      'https://local.maple.example.com',
    ]);
  });

  it('still falls back to the dev localhost ports when MAPLE_ORIGIN is unset', () => {
    delete process.env.MAPLE_ORIGIN;
    endpoint.mockReturnValue({ ip: 'local.maple.example.com', port: 443, scheme: 'https' });
    expect(allowedBrowserOrigins()).toEqual([
      'http://localhost:3000',
      'http://localhost:4200',
      'http://localhost:4201',
      'https://local.maple.example.com',
    ]);
  });
});
