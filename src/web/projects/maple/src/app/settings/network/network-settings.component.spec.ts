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
import { API_BASE_URL, type NetworkConfigResponse } from '@maple-common';
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

  /** Drive past ngOnInit's GET. */
  async function loadWith(
    cfg: NetworkConfigResponse | { error: string },
    status = 200,
  ): Promise<void> {
    fixture.detectChanges();
    const req = http.expectOne('/api/network/config');
    if (status === 200) {
      req.flush(cfg as NetworkConfigResponse);
    } else {
      req.flush(cfg, { status, statusText: 'Error' });
    }
    await Promise.resolve();
    fixture.detectChanges();
  }

  it('GETs /api/network/config on init and renders the resolved values', async () => {
    fixture.detectChanges();
    const req = http.expectOne('/api/network/config');
    expect(req.request.method).toBe('GET');
    req.flush(AUTO_DETECTED);
    await Promise.resolve();
    fixture.detectChanges();

    expect(el().textContent).toContain('192.168.1.50');
    expect(el().textContent).toContain('auto-detected');
    expect(el().textContent).toContain('3000');
  });

  it('leaves the override fields blank when the resolved address is only auto-detected', async () => {
    await loadWith(AUTO_DETECTED);

    const ipInput = el().querySelectorAll<HTMLInputElement>('.finput')[0];
    const portInput = el().querySelectorAll<HTMLInputElement>('.finput')[1];
    expect(ipInput.value).toBe('');
    expect(portInput.value).toBe('');
  });

  it('seeds the override fields from a saved db_override', async () => {
    await loadWith(OVERRIDDEN);

    const ipInput = el().querySelectorAll<HTMLInputElement>('.finput')[0];
    const portInput = el().querySelectorAll<HTMLInputElement>('.finput')[1];
    expect(ipInput.value).toBe('10.0.0.9');
    expect(portInput.value).toBe('8080');
  });

  it('shows the load-error message instead of the form when the GET fails', async () => {
    await loadWith({ error: 'boom' }, 500);

    expect(el().querySelector('.error')?.textContent).toContain('Failed to load config');
    expect(el().querySelector('.finput')).toBeNull();
  });

  it('PUTs the edited override shape when Save is clicked', async () => {
    await loadWith(AUTO_DETECTED);

    const ipInput = el().querySelectorAll<HTMLInputElement>('.finput')[0];
    ipInput.value = '10.0.0.9';
    ipInput.dispatchEvent(new Event('input'));
    fixture.detectChanges();

    const portInput = el().querySelectorAll<HTMLInputElement>('.finput')[1];
    portInput.value = '8080';
    portInput.dispatchEvent(new Event('input'));
    fixture.detectChanges();

    el().querySelector<HTMLButtonElement>('.btn-primary')!.click();

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

    const ipInput = el().querySelectorAll<HTMLInputElement>('.finput')[0];
    ipInput.value = '';
    ipInput.dispatchEvent(new Event('input'));
    const portInput = el().querySelectorAll<HTMLInputElement>('.finput')[1];
    portInput.value = '';
    portInput.dispatchEvent(new Event('input'));
    fixture.detectChanges();

    el().querySelector<HTMLButtonElement>('.btn-primary')!.click();

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

    const portInput = el().querySelectorAll<HTMLInputElement>('.finput')[1];
    portInput.value = '999999';
    portInput.dispatchEvent(new Event('input'));
    fixture.detectChanges();

    el().querySelector<HTMLButtonElement>('.btn-primary')!.click();
    fixture.detectChanges();

    expect(el().textContent).toContain('Port must be an integer between 1 and 65535.');
    // No PUT was issued — http.verify() in afterEach confirms no open request.
  });

  it('shows the save-error message when the PUT fails', async () => {
    await loadWith(AUTO_DETECTED);

    el().querySelector<HTMLButtonElement>('.btn-primary')!.click();
    http
      .expectOne('/api/network/config')
      .flush({ error: 'nope' }, { status: 500, statusText: 'Server Error' });
    await Promise.resolve();
    fixture.detectChanges();

    expect(el().textContent).toContain('nope');
  });
});
