// Unit coverage for applyNetworkPreference's decision logic — no TestBed /
// browser DOM needed, since the function takes its HTTP client, protocol,
// and fetch implementation as explicit parameters (see
// network-preference-bootstrap.ts for the rationale).

import { describe, it, expect, vi } from 'vitest';
import { of } from 'rxjs';
import { applyNetworkPreference } from './network-preference-bootstrap';
import { ApiBaseUrlStore } from '../api/api-base-url-store';
import type { LocalAddressReport } from './local-address-report.model';

function makeHttp(report: LocalAddressReport) {
  return { get: vi.fn(() => of(report)) };
}

function okFetch(report: LocalAddressReport): typeof fetch {
  return vi.fn(
    async () => new Response(JSON.stringify(report), { status: 200 }),
  ) as unknown as typeof fetch;
}

describe('applyNetworkPreference', () => {
  it('no-ops when the server reports no LAN address available', async () => {
    const store = new ApiBaseUrlStore();
    const http = makeHttp({ available: false });
    const fetchImpl = vi.fn();
    await applyNetworkPreference(http, store, 'https:', fetchImpl as unknown as typeof fetch);
    expect(store.value).toBe('/api');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('no-ops without probing when the page is HTTPS and the candidate is HTTP (mixed content)', async () => {
    const store = new ApiBaseUrlStore();
    const report: LocalAddressReport = {
      available: true,
      ip: '192.168.1.42',
      port: 3000,
      scheme: 'http',
    };
    const http = makeHttp(report);
    const fetchImpl = vi.fn();
    await applyNetworkPreference(http, store, 'https:', fetchImpl as unknown as typeof fetch);
    expect(store.value).toBe('/api');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('switches to the LAN address when the page and candidate scheme match and the probe succeeds', async () => {
    const store = new ApiBaseUrlStore();
    const report: LocalAddressReport = {
      available: true,
      ip: '192.168.1.42',
      port: 3000,
      scheme: 'http',
    };
    const http = makeHttp(report);
    const fetchImpl = okFetch(report);
    await applyNetworkPreference(http, store, 'http:', fetchImpl);
    expect(store.value).toBe('http://192.168.1.42:3000/api');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('stays on the public URL when the reachability probe fails', async () => {
    const store = new ApiBaseUrlStore();
    const report: LocalAddressReport = {
      available: true,
      ip: '192.168.1.42',
      port: 3000,
      scheme: 'http',
    };
    const http = makeHttp(report);
    const fetchImpl = vi.fn(async () => {
      throw new Error('network error');
    }) as unknown as typeof fetch;
    await applyNetworkPreference(http, store, 'http:', fetchImpl);
    expect(store.value).toBe('/api');
  });

  it('stays on the public URL when the probe reaches a different/non-Maple server', async () => {
    const store = new ApiBaseUrlStore();
    const report: LocalAddressReport = {
      available: true,
      ip: '192.168.1.42',
      port: 3000,
      scheme: 'http',
    };
    const http = makeHttp(report);
    // Something answers at that IP:port, but it isn't advertising a LAN
    // address of its own — not the same server.
    const fetchImpl = okFetch({ available: false });
    await applyNetworkPreference(http, store, 'http:', fetchImpl);
    expect(store.value).toBe('/api');
  });

  it('never throws when the initial report fetch itself fails', async () => {
    const store = new ApiBaseUrlStore();
    const http = {
      get: vi.fn(() => {
        throw new Error('boom');
      }),
    };
    await expect(
      applyNetworkPreference(http, store, 'https:', vi.fn() as unknown as typeof fetch),
    ).resolves.toBeUndefined();
    expect(store.value).toBe('/api');
  });
});
