// ObservabilityComponent — local toggle vs pulled-config precedence, config
// provenance, IndexedDB cache-status rendering, test-event dispatch.
//
// All network/IndexedDB/OTel-SDK plumbing lives in ObservabilityService,
// which is stubbed wholesale as a Partial (house pattern) — the component's
// own job is purely the local opt-out signal, the editable form, and reading
// the service's public signals, so there's nothing to gain from driving real
// HTTP here and a lot to lose (the real service also spins up OpenTelemetry
// exporters).

import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { provideRouter } from '@angular/router';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { signal, type WritableSignal } from '@angular/core';
import {
  ObservabilityService,
  STORAGE_KEYS,
  TypedStorage,
  type ObservabilityConfigResponse,
} from '@maple-common';
import { ObservabilityComponent } from './observability.component';

describe('ObservabilityComponent', () => {
  let fixture: ComponentFixture<ObservabilityComponent>;
  let http: HttpTestingController | null = null;
  let config: WritableSignal<ObservabilityConfigResponse | null>;
  let initialized: WritableSignal<boolean>;
  let lastError: WritableSignal<string | null>;
  let cachedAt: WritableSignal<number | null>;
  let refresh: ReturnType<typeof vi.fn>;
  let saveConfig: ReturnType<typeof vi.fn>;
  let testConnection: ReturnType<typeof vi.fn>;
  let recordLog: ReturnType<typeof vi.fn>;

  const CFG: ObservabilityConfigResponse = {
    enabled: true,
    endpoint: 'https://signoz.example.com:4318',
    ingestion_key_set: true,
    service_namespace: 'maple-prod',
    traces_enabled: true,
    logs_enabled: true,
    metrics_enabled: false,
    sample_ratio: 1,
    source: { endpoint: 'db', ingestion_key: 'db', service_namespace: 'db' },
  };

  async function setup(
    overrides: { saveConfig?: typeof saveConfig; testConnection?: typeof testConnection } = {},
  ): Promise<void> {
    TestBed.resetTestingModule();
    config = signal<ObservabilityConfigResponse | null>(null);
    initialized = signal(false);
    lastError = signal<string | null>(null);
    cachedAt = signal<number | null>(null);
    refresh = vi.fn().mockResolvedValue(undefined);
    saveConfig = overrides.saveConfig ?? vi.fn().mockResolvedValue(CFG);
    testConnection = overrides.testConnection ?? vi.fn().mockResolvedValue({ ok: true });
    recordLog = vi.fn();

    await TestBed.configureTestingModule({
      imports: [ObservabilityComponent],
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        provideRouter([]),
        {
          provide: ObservabilityService,
          useValue: {
            config,
            initialized,
            lastError,
            cachedAt,
            refresh,
            saveConfig,
            testConnection,
            recordLog,
          },
        },
      ],
    }).compileComponents();
    http = TestBed.inject(HttpTestingController);
    fixture = TestBed.createComponent(ObservabilityComponent);
  }

  beforeEach(() => {
    http = null;
    localStorage.removeItem(STORAGE_KEYS.OBSERVABILITY_ENABLED);
  });
  afterEach(() => {
    // The component reaches SigNoz/OTel exclusively through the stubbed
    // ObservabilityService, so the expectation is zero HttpClient traffic.
    // verify() turns that into a real assertion instead of an unused testing
    // backend: an unflushed or unexpected request now fails the test rather
    // than passing silently. Null when a test never called setup().
    http?.verify();
    localStorage.removeItem(STORAGE_KEYS.OBSERVABILITY_ENABLED);
  });

  const el = (): HTMLElement => fixture.nativeElement as HTMLElement;

  it('calls ObservabilityService.refresh() on init', async () => {
    await setup();
    fixture.detectChanges();
    expect(refresh).toHaveBeenCalledOnce();
  });

  it('renders "Loading configuration…" until config() resolves, then the resolved values with provenance', async () => {
    await setup();
    fixture.detectChanges();
    expect(el().textContent).toContain('Loading configuration…');

    config.set(CFG);
    fixture.detectChanges();

    expect(el().textContent).toContain('https://signoz.example.com:4318');
    expect(el().textContent).toContain('maple-prod');
    // Provenance labels: 'db' -> 'saved'.
    expect(el().querySelector('.config-grid')?.textContent).toContain('saved');
    expect(el().textContent).toContain('configured');
  });

  it('renders the load-error message when config() stays null and lastError() is set', async () => {
    await setup();
    lastError.set('network unreachable');
    fixture.detectChanges();

    expect(el().textContent).toContain('Failed to load config: network unreachable');
  });

  it('active() requires local-enabled AND server-initialized AND cfg.enabled AND an endpoint', async () => {
    await setup();
    config.set(CFG);
    initialized.set(true);
    fixture.detectChanges();

    // All four conditions true -> active.
    expect(el().textContent).toContain('Telemetry is active');

    // Local opt-out alone flips it inactive, even though the server config
    // and SDK are otherwise fully live — this is the precedence the ticket
    // calls out.
    el().querySelector<HTMLButtonElement>('.switch')!.click();
    fixture.detectChanges();
    expect(el().textContent).toContain('Telemetry is inactive in this session.');
  });

  it('active() stays false when the server config is enabled but the SDK never initialized', async () => {
    await setup();
    config.set(CFG);
    initialized.set(false);
    fixture.detectChanges();

    expect(el().textContent).toContain('Telemetry is inactive in this session.');
  });

  it('toggling local persists to localStorage under the observability-enabled key', async () => {
    await setup();
    fixture.detectChanges();

    el().querySelector<HTMLButtonElement>('.switch')!.click();
    expect(TypedStorage.get<boolean>(STORAGE_KEYS.OBSERVABILITY_ENABLED)).toBe(false);

    el().querySelector<HTMLButtonElement>('.switch')!.click();
    expect(TypedStorage.get<boolean>(STORAGE_KEYS.OBSERVABILITY_ENABLED)).toBe(true);
  });

  it('starts opted out when localStorage already has the flag set to false', async () => {
    TypedStorage.set(STORAGE_KEYS.OBSERVABILITY_ENABLED, false);
    await setup();
    config.set(CFG);
    initialized.set(true);
    fixture.detectChanges();

    expect(el().textContent).toContain('Telemetry is inactive in this session.');
  });

  it('renders the cache line as "No cached configuration yet" when cachedAt() is null, and the refreshed time once set', async () => {
    await setup();
    fixture.detectChanges();
    expect(el().textContent).toContain('No cached configuration yet');

    const ts = Date.UTC(2026, 7, 14, 12, 0, 0);
    cachedAt.set(ts);
    fixture.detectChanges();

    expect(el().textContent).toContain('last refreshed');
    expect(el().textContent).not.toContain('No cached configuration yet');
  });

  it('sendTestEvent calls ObservabilityService.recordLog with the maple.test_event marker when active', async () => {
    await setup();
    config.set(CFG);
    initialized.set(true);
    fixture.detectChanges();

    el().querySelector<HTMLButtonElement>('.test-row .btn-primary')!.click();
    fixture.detectChanges();

    expect(recordLog).toHaveBeenCalledOnce();
    const [level, message, attrs] = recordLog.mock.calls[0];
    expect(level).toBe('info');
    expect(message).toBe('Maple web test event');
    expect(attrs).toMatchObject({
      'maple.test_event': true,
      'maple.source': 'settings.observability',
    });
    expect(el().textContent).toContain('Sent — check the SigNoz logs view');
  });

  it('sendTestEvent shows an error and does not call recordLog when telemetry is inactive', async () => {
    await setup();
    config.set(CFG);
    initialized.set(false); // inactive
    fixture.detectChanges();

    el().querySelector<HTMLButtonElement>('.test-row .btn-primary')!.click();
    fixture.detectChanges();

    expect(recordLog).not.toHaveBeenCalled();
    expect(el().textContent).toContain(
      'Telemetry is inactive — enable it and confirm an endpoint is set.',
    );
  });

  it('Save seeds the patch from the form, omits ingestion_key when blank, and calls saveConfig', async () => {
    await setup();
    config.set(CFG);
    fixture.detectChanges();

    el().querySelector<HTMLButtonElement>('.form-actions .btn-primary')!.click();
    await Promise.resolve();
    fixture.detectChanges();

    expect(saveConfig).toHaveBeenCalledWith({
      enabled: true,
      endpoint: 'https://signoz.example.com:4318',
      service_namespace: 'maple-prod',
      traces_enabled: true,
      logs_enabled: true,
      metrics_enabled: false,
      sample_ratio: 1,
    });
    expect(el().textContent).toContain('Saved.');
  });

  it('Save includes ingestion_key only when the operator typed one', async () => {
    await setup();
    config.set(CFG);
    fixture.detectChanges();

    const keyInput = el().querySelector<HTMLInputElement>('input[type="password"]')!;
    keyInput.value = 'signoz-secret';
    keyInput.dispatchEvent(new Event('input'));
    fixture.detectChanges();

    el().querySelector<HTMLButtonElement>('.form-actions .btn-primary')!.click();
    await Promise.resolve();

    expect(saveConfig.mock.calls[0][0]).toMatchObject({ ingestion_key: 'signoz-secret' });
  });

  it('rejects an out-of-range sample ratio locally without calling saveConfig', async () => {
    await setup();
    config.set(CFG);
    fixture.detectChanges();

    // Selected by inputmode rather than `.finput` index: the ratio field is
    // the only decimal input in the template, so this survives a field
    // reorder that would silently repoint a positional `[3]` at the wrong
    // control.
    const ratioInput = el().querySelector<HTMLInputElement>('input[inputmode="decimal"]')!;
    ratioInput.value = '2';
    ratioInput.dispatchEvent(new Event('input'));
    fixture.detectChanges();

    el().querySelector<HTMLButtonElement>('.form-actions .btn-primary')!.click();
    fixture.detectChanges();

    expect(saveConfig).not.toHaveBeenCalled();
    expect(el().textContent).toContain('Sample ratio must be a number between 0 and 1.');
  });

  it('shows the save-error message when saveConfig rejects', async () => {
    await setup({ saveConfig: vi.fn().mockRejectedValue(new Error('server unreachable')) });
    config.set(CFG);
    fixture.detectChanges();

    el().querySelector<HTMLButtonElement>('.form-actions .btn-primary')!.click();
    await Promise.resolve();
    fixture.detectChanges();

    expect(el().textContent).toContain('server unreachable');
  });

  it('Test connection calls ObservabilityService.testConnection with the typed endpoint and key', async () => {
    await setup();
    config.set(CFG);
    fixture.detectChanges();

    const endpointInput = el().querySelector<HTMLInputElement>('input[type="url"]')!;
    endpointInput.value = 'https://otel.example.com';
    endpointInput.dispatchEvent(new Event('input'));
    fixture.detectChanges();

    el().querySelector<HTMLButtonElement>('.form-actions .btn-ghost')!.click();
    await Promise.resolve();
    fixture.detectChanges();

    expect(testConnection).toHaveBeenCalledWith('https://otel.example.com', null);
    expect(el().textContent).toContain('Endpoint reachable.');
  });

  it('Test connection surfaces the server-reported error', async () => {
    await setup({
      testConnection: vi.fn().mockResolvedValue({ ok: false, error: 'connection refused' }),
    });
    config.set(CFG);
    fixture.detectChanges();

    const endpointInput = el().querySelector<HTMLInputElement>('input[type="url"]')!;
    endpointInput.value = 'https://otel.example.com';
    endpointInput.dispatchEvent(new Event('input'));
    fixture.detectChanges();

    el().querySelector<HTMLButtonElement>('.form-actions .btn-ghost')!.click();
    await Promise.resolve();
    fixture.detectChanges();

    expect(el().textContent).toContain('connection refused');
  });
});
