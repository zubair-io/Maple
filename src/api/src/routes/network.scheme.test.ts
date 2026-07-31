/**
 * Unit test for `buildLocalAddressResponse` (#2415) — the pure function that
 * turns a resolved network config + the TLS-enabled flag into the wire shape
 * for `GET /api/network/local-address`. Unlike `network.test.ts` (route
 * integration, requires a live MongoDB), this injects both inputs directly
 * so it needs neither Mongo nor a real TLS cert.
 */

import { describe, it, expect } from 'bun:test';
import { buildLocalAddressResponse } from './network.ts';
import type { ResolvedNetworkConfig } from '../network/network-config.repo.ts';

function resolved(overrides: Partial<ResolvedNetworkConfig> = {}): ResolvedNetworkConfig {
  return {
    enabled: true,
    local_ip: '192.168.1.42',
    local_port: 3000,
    source: { local_ip: 'auto_detected', local_port: 'default' },
    ...overrides,
  };
}

describe('buildLocalAddressResponse', () => {
  it('advertises scheme: "http" when TLS is not enabled', () => {
    expect(buildLocalAddressResponse(resolved(), false)).toEqual({
      available: true,
      ip: '192.168.1.42',
      port: 3000,
      scheme: 'http',
    });
  });

  it('advertises scheme: "https" when TLS is enabled', () => {
    expect(buildLocalAddressResponse(resolved(), true)).toEqual({
      available: true,
      ip: '192.168.1.42',
      port: 3000,
      scheme: 'https',
    });
  });

  it('reports unavailable (no scheme) when disabled, regardless of TLS state', () => {
    expect(buildLocalAddressResponse(resolved({ enabled: false }), true)).toEqual({
      available: false,
    });
  });

  it('reports unavailable (no scheme) when no LAN IP resolved, regardless of TLS state', () => {
    expect(buildLocalAddressResponse(resolved({ local_ip: null }), true)).toEqual({
      available: false,
    });
  });
});
