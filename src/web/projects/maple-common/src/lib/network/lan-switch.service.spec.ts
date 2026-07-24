import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { LanSwitchService } from './lan-switch.service';
import { AuthService } from '../auth/auth.service';
import type { LocalAddressReport } from './local-address-report.model';

function okFetch(report: LocalAddressReport): typeof fetch {
  return vi.fn(
    async () => new Response(JSON.stringify(report), { status: 200 }),
  ) as unknown as typeof fetch;
}

describe('LanSwitchService.checkAvailable', () => {
  let service: LanSwitchService;
  let ctrl: HttpTestingController;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [provideHttpClient(), provideHttpClientTesting()],
    });
    service = TestBed.inject(LanSwitchService);
    ctrl = TestBed.inject(HttpTestingController);
  });

  afterEach(() => {
    ctrl.verify();
    vi.unstubAllGlobals();
  });

  it('returns null when the server reports no LAN address available', async () => {
    const p = service.checkAvailable('https:');
    ctrl.expectOne('/api/network/local-address').flush({ available: false });
    expect(await p).toBeNull();
  });

  it('offers the candidate UNCONFIRMED (no probe) when the page is HTTPS and the candidate is HTTP', async () => {
    const fetchImpl = okFetch({ available: false });
    vi.stubGlobal('fetch', fetchImpl);

    const p = service.checkAvailable('https:');
    ctrl.expectOne('/api/network/local-address').flush({
      available: true,
      ip: '192.168.1.42',
      port: 3000,
      scheme: 'http',
    });
    expect(await p).toEqual({ origin: 'http://192.168.1.42:3000' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('confirms via probe and offers the candidate when schemes match and the probe confirms', async () => {
    const report: LocalAddressReport = {
      available: true,
      ip: '192.168.1.42',
      port: 3000,
      scheme: 'http',
    };
    const fetchImpl = okFetch(report);
    vi.stubGlobal('fetch', fetchImpl);

    const p = service.checkAvailable('http:');
    ctrl.expectOne('/api/network/local-address').flush(report);
    expect(await p).toEqual({ origin: 'http://192.168.1.42:3000' });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('returns null when schemes match but the probe fails', async () => {
    const report: LocalAddressReport = {
      available: true,
      ip: '192.168.1.42',
      port: 3000,
      scheme: 'http',
    };
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('network error');
      }),
    );

    const p = service.checkAvailable('http:');
    ctrl.expectOne('/api/network/local-address').flush(report);
    expect(await p).toBeNull();
  });

  it('returns null when the probe reaches a different/unrelated server', async () => {
    const report: LocalAddressReport = {
      available: true,
      ip: '192.168.1.42',
      port: 3000,
      scheme: 'http',
    };
    // Something answers at that address, but reports a different ip/port —
    // not the same server.
    vi.stubGlobal('fetch', okFetch({ available: true, ip: '192.168.1.99', port: 8080 }));

    const p = service.checkAvailable('http:');
    ctrl.expectOne('/api/network/local-address').flush(report);
    expect(await p).toBeNull();
  });

  it('returns null without probing when the page is already on the candidate LAN origin', async () => {
    const fetchImpl = okFetch({ available: false });
    vi.stubGlobal('fetch', fetchImpl);

    const p = service.checkAvailable('http:', { hostname: '192.168.1.42', port: '3000' });
    ctrl.expectOne('/api/network/local-address').flush({
      available: true,
      ip: '192.168.1.42',
      port: 3000,
      scheme: 'http',
    });
    expect(await p).toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('still offers the candidate when only the hostname matches but the port differs', async () => {
    const report: LocalAddressReport = {
      available: true,
      ip: '192.168.1.42',
      port: 3000,
      scheme: 'http',
    };
    vi.stubGlobal('fetch', okFetch(report));

    const p = service.checkAvailable('http:', { hostname: '192.168.1.42', port: '8080' });
    ctrl.expectOne('/api/network/local-address').flush(report);
    expect(await p).toEqual({ origin: 'http://192.168.1.42:3000' });
  });

  it('treats an empty page port as the scheme default when comparing to the candidate', async () => {
    // A page loaded as http://192.168.1.42/ (no explicit port, default 80)
    // IS already at a candidate reporting port 80 — no banner.
    const fetchImpl = okFetch({ available: false });
    vi.stubGlobal('fetch', fetchImpl);

    const p = service.checkAvailable('http:', { hostname: '192.168.1.42', port: '' });
    ctrl.expectOne('/api/network/local-address').flush({
      available: true,
      ip: '192.168.1.42',
      port: 80,
      scheme: 'http',
    });
    expect(await p).toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe('LanSwitchService.switchTo', () => {
  let service: LanSwitchService;
  let issueLanHandoffCode: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    issueLanHandoffCode = vi.fn();
    TestBed.configureTestingModule({
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        { provide: AuthService, useValue: { issueLanHandoffCode } },
      ],
    });
    service = TestBed.inject(LanSwitchService);
  });

  it('mints a code and navigates to the LAN origin with it', async () => {
    issueLanHandoffCode.mockResolvedValue('CODE123');
    const navigated: string[] = [];
    (service as unknown as { navigateTo: (u: string) => void }).navigateTo = (u) =>
      navigated.push(u);

    const ok = await service.switchTo({ origin: 'http://192.168.1.42:3000' });
    expect(ok).toBe(true);
    expect(navigated).toEqual(['http://192.168.1.42:3000/?lan_handoff=CODE123']);
  });

  it('returns false and does not navigate when code issuance fails', async () => {
    issueLanHandoffCode.mockResolvedValue(null);
    const navigated: string[] = [];
    (service as unknown as { navigateTo: (u: string) => void }).navigateTo = (u) =>
      navigated.push(u);

    const ok = await service.switchTo({ origin: 'http://192.168.1.42:3000' });
    expect(ok).toBe(false);
    expect(navigated).toEqual([]);
  });
});
