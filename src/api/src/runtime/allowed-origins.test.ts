/**
 * Browser origin allowlist (#3519). The managed LAN HTTPS hostname is a
 * runtime setting, so it must reach the WebAuthn and WebSocket gates without
 * an operator editing `MAPLE_ORIGIN` and redeploying.
 *
 * `MAPLE_ORIGIN` is set inside each test (the helper reads it per-call) so a
 * sibling test file's top-level env mutation can't bleed in.
 */
import { afterAll, afterEach, describe, expect, it, spyOn } from 'bun:test';
import { managedHttps } from '../network/managed-https.ts';
import { allowedBrowserOrigins, managedHttpsOrigin } from './allowed-origins.ts';

const ORIGINAL_ORIGIN = process.env.MAPLE_ORIGIN;
const endpoint = spyOn(managedHttps, 'endpoint');

afterEach(() => endpoint.mockReset());
afterAll(() => {
  endpoint.mockRestore();
  if (ORIGINAL_ORIGIN === undefined) delete process.env.MAPLE_ORIGIN;
  else process.env.MAPLE_ORIGIN = ORIGINAL_ORIGIN;
});

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
