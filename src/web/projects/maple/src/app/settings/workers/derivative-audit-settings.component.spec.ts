import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { API_BASE_URL, type DerivativeAuditStatusDto } from '@maple-common';
import { DerivativeAuditSettingsComponent } from './derivative-audit-settings.component';

const STATUS_URL = '/api/derivative-audit/status';

const status: DerivativeAuditStatusDto = {
  config: {
    enabled: true,
    interval_ms: 21_600_000,
    max_resets_per_pass: 500,
    concurrency: 8,
    deep_r2_enabled: true,
  },
  progress: {
    scanned: 42,
    reArmed: 3,
    byStage: { thumb: 2, preview: 1 },
    skippedCooldown: 0,
    errors: 0,
    startedAt: '2026-07-22T00:00:00.000Z',
    finishedAt: '2026-07-22T00:01:00.000Z',
    running: false,
  },
};

describe('DerivativeAuditSettingsComponent', () => {
  let fixture: ComponentFixture<DerivativeAuditSettingsComponent>;
  let http: HttpTestingController;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [DerivativeAuditSettingsComponent],
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        { provide: API_BASE_URL, useValue: '/api' },
      ],
    }).compileComponents();
    fixture = TestBed.createComponent(DerivativeAuditSettingsComponent);
    http = TestBed.inject(HttpTestingController);
    fixture.detectChanges();
  });

  afterEach(() => http.verify());

  const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

  it('loads status and renders config + last-pass readout', async () => {
    const req = http.expectOne(STATUS_URL);
    expect(req.request.method).toBe('GET');
    req.flush(status);
    await tick();
    fixture.detectChanges();

    const el = fixture.nativeElement as HTMLElement;
    expect(el.querySelector('[data-testid="audit-status"]')?.textContent).toContain('Enabled');
    expect((el.querySelector('[data-testid="audit-enabled"]') as HTMLInputElement).checked).toBe(
      true,
    );
    expect((el.querySelector('[data-testid="audit-max-resets"]') as HTMLInputElement).value).toBe(
      '500',
    );
    expect(el.querySelector('[data-testid="audit-summary"]')?.textContent).toContain('42 scanned');
    expect(el.querySelector('[data-testid="audit-stage-counts"]')?.textContent).toContain(
      'thumb: 2',
    );
  });

  it('toggling enabled PUTs the config', async () => {
    http.expectOne(STATUS_URL).flush(status);
    await tick();
    fixture.detectChanges();

    const box = fixture.nativeElement.querySelector(
      '[data-testid="audit-enabled"]',
    ) as HTMLInputElement;
    box.checked = false;
    box.dispatchEvent(new Event('change'));
    await tick();

    const put = http.expectOne('/api/derivative-audit/config');
    expect(put.request.method).toBe('PUT');
    expect(put.request.body).toEqual({ enabled: false });
    put.flush({ ok: true, config: { ...status.config, enabled: false } });
  });
});
