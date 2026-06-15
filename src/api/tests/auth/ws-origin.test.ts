/**
 * WebSocket Origin allowlist (#863) — cross-site WebSocket-hijack defense on the
 * `/api/events` handshake. (The post-connect auth-frame + exp-recheck flow is
 * integration-level and exercised by the web client + manual runs; this covers
 * the pure allowlist decision.)
 *
 * MAPLE_ORIGIN is set inside each test (the helper reads it per-call) so a
 * sibling test file's top-level env mutation can't bleed in.
 */
import { describe, it, expect, afterAll } from 'bun:test';
import { isWsOriginAllowed } from '../../src/routes/events.ts';

const ORIGINAL_ORIGIN = process.env.MAPLE_ORIGIN;
afterAll(() => {
  if (ORIGINAL_ORIGIN === undefined) delete process.env.MAPLE_ORIGIN;
  else process.env.MAPLE_ORIGIN = ORIGINAL_ORIGIN;
});

describe('WS origin allowlist (#863)', () => {
  it('allows a configured origin and rejects a cross-site one', () => {
    process.env.MAPLE_ORIGIN = 'https://maple.example.com';
    expect(isWsOriginAllowed('https://maple.example.com')).toBe(true);
    expect(isWsOriginAllowed('https://evil.example.com')).toBe(false);
  });

  it('supports a comma-separated allowlist', () => {
    process.env.MAPLE_ORIGIN = 'https://a.example.com, https://b.example.com';
    expect(isWsOriginAllowed('https://a.example.com')).toBe(true);
    expect(isWsOriginAllowed('https://b.example.com')).toBe(true);
    expect(isWsOriginAllowed('https://c.example.com')).toBe(false);
  });

  it('allows a missing Origin (non-browser client — not subject to CSWSH)', () => {
    process.env.MAPLE_ORIGIN = 'https://maple.example.com';
    expect(isWsOriginAllowed(undefined)).toBe(true);
    expect(isWsOriginAllowed(null)).toBe(true);
    expect(isWsOriginAllowed('')).toBe(true);
  });

  it('falls back to localhost dev ports when MAPLE_ORIGIN is unset', () => {
    delete process.env.MAPLE_ORIGIN;
    expect(isWsOriginAllowed('http://localhost:4200')).toBe(true);
    expect(isWsOriginAllowed('http://localhost:3000')).toBe(true);
    expect(isWsOriginAllowed('https://evil.example.com')).toBe(false);
  });
});
