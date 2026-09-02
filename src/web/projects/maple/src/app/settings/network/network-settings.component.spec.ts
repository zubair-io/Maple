// NetworkSettingsComponent — GET populates the LAN-override form, PUT sends
// the edited shape, error path.
//
// The component talks to BunApiBackendService via `firstValueFrom(...)`
// inside `async` methods, so each state update lands one microtask AFTER
// the matching `flush()` — every test awaits a `Promise.resolve()` tick in
// between (`load()`/`save()`'s `await` continuation needs it to run before
// the assertions).

import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { provideRouter } from '@angular/router';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { API_BASE_URL, type ApnsConfigResponse, type NetworkConfigResponse } from '@maple-common';
import { NetworkSettingsComponent } from './network-settings.component';

describe('NetworkSettingsComponent', () => {
  let fixture: ComponentFixture<NetworkSettingsComponent>;
  let http: HttpTestingController;

  const AUTO_DETECTED: NetworkConfigResponse = {
    enabled: true,
    local_ip: '192.168.1.50',
    local_port: 3000,
    source: { local_ip: 'auto_detected', local_port: 'default' },
  };

  const OVERRIDDEN: NetworkConfigResponse = {
    enabled: true,
    local_ip: '10.0.0.9',
    local_port: 8080,
    source: { local_ip: 'db_override', local_port: 'db_override' },
  };

  const APNS_OFF: ApnsConfigResponse = { enabled: false, credentials_configured: false };

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [NetworkSettingsComponent],
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        provideRouter([]),
        { provide: API_BASE_URL, useValue: '/api' },
      ],
    }).compileComponents();
    fixture = TestBed.createComponent(NetworkSettingsComponent);
    http = TestBed.inject(HttpTestingController);
  });

  afterEach(() => http.verify());

  const el = (): HTMLElement => fixture.nativeElement as HTMLElement;

  function ipInput(): HTMLInputElement {
    const found = el().querySelector<HTMLInputElement>('mui-input input[aria-label="LAN address"]');
    if (!found) throw new Error('missing LAN address input');
    return found;
  }

  function portInput(): HTMLInputElement {
    const found = el().querySelector<HTMLInputElement>('mui-input input[aria-label="Port"]');
    if (!found) throw new Error('missing port input');
    return found;
  }

  function clickSave(): void {
    const btn = el().querySelector<HTMLButtonElement>('mui-button button');
    if (!btn) throw new Error('missing save button');
    btn.click();
  }

  /** Drive past ngOnInit's two GETs (LAN-address config + APNs config —
   * independent load paths, see the component's ngOnInit). `apnsCfg`
   * defaults to push-off / no-credentials since most tests only care
   * about the LAN-address form. */
  async function loadWith(
    cfg: NetworkConfigResponse | { error: string },
    status = 200,
    apnsCfg: ApnsConfigResponse = APNS_OFF,
  ): Promise<void> {
    fixture.detectChanges();
    const req = http.expectOne('/api/network/config');
    if (status === 200) {
      req.flush(cfg as NetworkConfigResponse);
    } else {
      req.flush(cfg, { status, statusText: 'Error' });
    }
    http.expectOne('/api/apns/config').flush(apnsCfg);
    await Promise.resolve();
    fixture.detectChanges();
  }

  it('GETs /api/network/config on init and renders the resolved values', async () => {
    fixture.detectChanges();
    const req = http.expectOne('/api/network/config');
    expect(req.request.method).toBe('GET');
    req.flush(AUTO_DETECTED);
    http.expectOne('/api/apns/config').flush(APNS_OFF);
    await Promise.resolve();
    fixture.detectChanges();

    expect(el().textContent).toContain('192.168.1.50');
    expect(el().textContent).toContain('auto-detected');
    expect(el().textContent).toContain('3000');
  });

  it('leaves the override fields blank when the resolved address is only auto-detected', async () => {
    await loadWith(AUTO_DETECTED);

    expect(ipInput().value).toBe('');
    expect(portInput().value).toBe('');
  });

  it('seeds the override fields from a saved db_override', async () => {
    await loadWith(OVERRIDDEN);

    expect(ipInput().value).toBe('10.0.0.9');
    expect(portInput().value).toBe('8080');
  });

  it('shows the load-error message instead of the form when the GET fails', async () => {
    await loadWith({ error: 'boom' }, 500);

    expect(el().querySelector('.error')?.textContent).toContain('Failed to load config');
    expect(el().querySelector('mui-input input')).toBeNull();
  });

  it('PUTs the edited override shape when Save is clicked', async () => {
    await loadWith(AUTO_DETECTED);

    ipInput().value = '10.0.0.9';
    ipInput().dispatchEvent(new Event('input'));
    fixture.detectChanges();

    portInput().value = '8080';
    portInput().dispatchEvent(new Event('input'));
    fixture.detectChanges();

    clickSave();

    const req = http.expectOne('/api/network/config');
    expect(req.request.method).toBe('PUT');
    expect(req.request.body).toEqual({
      enabled: true,
      local_ip_override: '10.0.0.9',
      local_port_override: 8080,
    });
    req.flush(OVERRIDDEN);
    await Promise.resolve();
    fixture.detectChanges();

    expect(el().textContent).toContain('Saved.');
  });

  it('sends null overrides when both fields are cleared (clears back to auto-detect)', async () => {
    await loadWith(OVERRIDDEN);

    ipInput().value = '';
    ipInput().dispatchEvent(new Event('input'));
    portInput().value = '';
    portInput().dispatchEvent(new Event('input'));
    fixture.detectChanges();

    clickSave();

    const req = http.expectOne('/api/network/config');
    expect(req.request.body).toEqual({
      enabled: true,
      local_ip_override: null,
      local_port_override: null,
    });
    req.flush(AUTO_DETECTED);
    await Promise.resolve();
    fixture.detectChanges();
  });

  it('rejects an out-of-range port locally without calling the API', async () => {
    await loadWith(AUTO_DETECTED);

    portInput().value = '999999';
    portInput().dispatchEvent(new Event('input'));
    fixture.detectChanges();

    clickSave();
    fixture.detectChanges();

    expect(el().textContent).toContain('Port must be an integer between 1 and 65535.');
    // No PUT was issued — http.verify() in afterEach confirms no open request.
  });

  it('shows the save-error message when the PUT fails', async () => {
    await loadWith(AUTO_DETECTED);

    clickSave();
    http
      .expectOne('/api/network/config')
      .flush({ error: 'nope' }, { status: 500, statusText: 'Server Error' });
    await Promise.resolve();
    fixture.detectChanges();

    expect(el().textContent).toContain('nope');
  });

  // ── APNs push-to-signal (#1025) — independent load/save ─────────────────

  function apnsCheckbox(): HTMLInputElement {
    const boxes = Array.from(
      el().querySelectorAll<HTMLInputElement>('mui-checkbox input[type="checkbox"]'),
    );
    const found = boxes.find((b) =>
      b.closest('mui-checkbox')?.textContent?.includes('push notifications'),
    );
    if (!found) throw new Error('missing APNs push checkbox');
    return found;
  }

  it('GETs /api/apns/config on init and reflects the loaded toggle state', async () => {
    await loadWith(AUTO_DETECTED, 200, { enabled: true, credentials_configured: true });

    expect(apnsCheckbox().checked).toBe(true);
    expect(el().textContent).not.toContain('no Apple push credentials configured');
  });

  it('warns when push is enabled but the server has no APNs credentials', async () => {
    await loadWith(AUTO_DETECTED, 200, { enabled: true, credentials_configured: false });

    expect(el().textContent).toContain('no Apple push credentials configured');
  });

  it('does NOT warn about missing credentials while the toggle is off (Copilot review #3214)', async () => {
    await loadWith(AUTO_DETECTED, 200, { enabled: false, credentials_configured: false });

    expect(el().textContent).not.toContain('no Apple push credentials configured');
  });

  it('shows the APNs load-error message when its GET fails', async () => {
    fixture.detectChanges();
    http.expectOne('/api/network/config').flush(AUTO_DETECTED);
    http
      .expectOne('/api/apns/config')
      .flush({ error: 'boom' }, { status: 500, statusText: 'Error' });
    await Promise.resolve();
    fixture.detectChanges();

    expect(el().textContent).toContain('Failed to load config');
  });

  it('PUTs the toggle and shows Saved when the checkbox is flipped', async () => {
    await loadWith(AUTO_DETECTED, 200, APNS_OFF);

    apnsCheckbox().checked = true;
    apnsCheckbox().dispatchEvent(new Event('change'));

    const req = http.expectOne('/api/apns/config');
    expect(req.request.method).toBe('PUT');
    expect(req.request.body).toEqual({ enabled: true });
    req.flush({ enabled: true, credentials_configured: false });
    await Promise.resolve();
    fixture.detectChanges();

    expect(el().textContent).toContain('Saved.');
  });

  it('shows the APNs save-error message AND reverts the checkbox when the PUT fails (Copilot review #3214)', async () => {
    await loadWith(AUTO_DETECTED, 200, APNS_OFF);

    apnsCheckbox().checked = true;
    apnsCheckbox().dispatchEvent(new Event('change'));
    fixture.detectChanges();
    // Optimistic flip — the checkbox shows the new state immediately,
    // before the PUT resolves.
    expect(apnsCheckbox().checked).toBe(true);

    http
      .expectOne('/api/apns/config')
      .flush({ error: 'apns nope' }, { status: 500, statusText: 'Server Error' });
    await Promise.resolve();
    fixture.detectChanges();

    expect(el().textContent).toContain('apns nope');
    // The PUT never persisted — the checkbox must revert to what the
    // server actually has, not stay stuck on the optimistic value.
    expect(apnsCheckbox().checked).toBe(false);
  });
});
