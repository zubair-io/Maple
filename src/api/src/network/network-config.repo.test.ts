import { describe, expect, it } from 'bun:test';
import {
  detectLocalIPv4,
  resolveNetworkConfig,
  validateLocalAddress,
} from './network-config.repo.ts';

describe('validateLocalAddress', () => {
  it('returns null for null input', () => {
    expect(validateLocalAddress(null)).toBeNull();
  });

  it('returns null for empty or whitespace-only input', () => {
    expect(validateLocalAddress('')).toBeNull();
    expect(validateLocalAddress('   ')).toBeNull();
  });

  it('trims and accepts a plain IPv4 address', () => {
    expect(validateLocalAddress('  192.168.1.42  ')).toBe('192.168.1.42');
  });

  it('accepts a hostname (not restricted to RFC1918 ranges)', () => {
    expect(validateLocalAddress('maple-server.tailnet.ts.net')).toBe('maple-server.tailnet.ts.net');
  });

  it('rejects a value containing whitespace', () => {
    expect(validateLocalAddress('192.168.1.42 extra')).toEqual({
      error: 'Address must not contain whitespace',
    });
  });
});

describe('detectLocalIPv4', () => {
  it('returns a string or null, never throws', () => {
    const result = detectLocalIPv4();
    expect(result === null || typeof result === 'string').toBe(true);
    if (result !== null) {
      expect(result).toMatch(/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/);
      expect(result).not.toBe('127.0.0.1');
    }
  });
});

describe('resolveNetworkConfig', () => {
  it('falls back to auto-detect when DB is null', () => {
    const resolved = resolveNetworkConfig(null);
    expect(resolved.enabled).toBe(true);
    expect(resolved.source.local_port).toBe('default');
    // local_ip reflects whatever detectLocalIPv4() returns on this host —
    // just assert internal consistency between the two.
    if (resolved.local_ip === null) {
      expect(resolved.source.local_ip).toBe('unavailable');
    } else {
      expect(resolved.source.local_ip).toBe('auto_detected');
    }
  });

  it('an IP override wins over auto-detect', () => {
    const resolved = resolveNetworkConfig({ local_ip_override: '10.0.0.5' });
    expect(resolved.local_ip).toBe('10.0.0.5');
    expect(resolved.source.local_ip).toBe('db_override');
  });

  it('a port override wins over the server default', () => {
    const resolved = resolveNetworkConfig({ local_port_override: 4000 });
    expect(resolved.local_port).toBe(4000);
    expect(resolved.source.local_port).toBe('db_override');
  });

  it('enabled: false forces local_ip to null regardless of overrides', () => {
    const resolved = resolveNetworkConfig({ enabled: false, local_ip_override: '10.0.0.5' });
    expect(resolved.enabled).toBe(false);
    expect(resolved.local_ip).toBeNull();
    expect(resolved.source.local_ip).toBe('unavailable');
  });

  it('ignores an empty-string override and falls back to auto-detect', () => {
    const resolved = resolveNetworkConfig({ local_ip_override: '   ' });
    expect(resolved.source.local_ip).not.toBe('db_override');
  });
});
