import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { API_BASE_URL, type ChangeLogGcStatusDto } from '@maple-common';
import { ChangeLogGcSettingsComponent } from './change-log-gc-settings.component';

const STATUS_URL = '/api/change-log-gc/status';
const CONFIG_URL = '/api/change-log-gc/config';

const status: ChangeLogGcStatusDto = {
  config: {
    enabled: true,
    retention_days: 30,
    last_run: {
      deleted: 1_200_000,
      batches: 240,
      duration_ms: 18_400,
      pruned_through: 175_000_000,
      remaining: 820_000,
      finished_at: '2026-09-17T03:00:00.000Z',
    },
  },
  rows: 820_000,
  pruned_through: 175_000_000,
};

describe('ChangeLogGcSettingsComponent', () => {
  let fixture: ComponentFixture<ChangeLogGcSettingsComponent>;
  let http: HttpTestingController;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [ChangeLogGcSettingsComponent],
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        { provide: API_BASE_URL, useValue: '/api' },
      ],
    }).compileComponents();
    fixture = TestBed.createComponent(ChangeLogGcSettingsComponent);
    http = TestBed.inject(HttpTestingController);
    fixture.detectChanges();
  });

  afterEach(() => http.verify());

  const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

  /** Expand the collapsible row so its body renders. */
  const expandRow = (): void => {
    (fixture.nativeElement.querySelector('.header') as HTMLElement).click();
    fixture.detectChanges();
  };

  const load = async (payload: ChangeLogGcStatusDto = status): Promise<void> => {
    const req = http.expectOne(STATUS_URL);
    expect(req.request.method).toBe('GET');
    req.flush(payload);
    await tick();
    fixture.detectChanges();
  };

  it('shows the journal size and last sweep while collapsed, and the window on expand', async () => {
    await load();
    const el = fixture.nativeElement as HTMLElement;

    expect(el.querySelector('[data-testid="change-log-gc-status"]')?.textContent).toContain(
      'Enabled',
    );
    expect(el.querySelector('[data-testid="change-log-gc-summary"]')?.textContent).toContain(
      'rows',
    );
    expect(el.querySelector('.content-wrapper')?.className).not.toContain('open');

    expandRow();
    expect(el.querySelector('.content-wrapper')?.className).toContain('open');
    expect(
      (el.querySelector('[data-testid="change-log-gc-retention"] input') as HTMLInputElement).value,
    ).toBe('30');
    expect(el.querySelector('[data-testid="change-log-gc-last-run"]')?.textContent).toContain(
      '240 batches',
    );
  });

  it('saving the retention window PUTs it and keeps the response value', async () => {
    await load();
    expandRow();

    const input = fixture.nativeElement.querySelector(
      '[data-testid="change-log-gc-retention"] input',
    ) as HTMLInputElement;
    input.value = '7';
    input.dispatchEvent(new Event('input'));
    await tick();
    fixture.detectChanges();

    (
      fixture.nativeElement.querySelector(
        '[data-testid="change-log-gc-save"] button',
      ) as HTMLElement
    ).click();
    await tick();

    const put = http.expectOne(CONFIG_URL);
    expect(put.request.method).toBe('PUT');
    expect(put.request.body).toEqual({ retention_days: 7 });
    put.flush({ ok: true, config: { ...status.config, retention_days: 7 } });
    await tick();
    fixture.detectChanges();

    expect(
      (
        fixture.nativeElement.querySelector(
          '[data-testid="change-log-gc-retention"] input',
        ) as HTMLInputElement
      ).value,
    ).toBe('7');
  });

  it('toggling enabled PUTs the flag on its own', async () => {
    await load();
    expandRow();

    const box = fixture.nativeElement.querySelector(
      '[data-testid="change-log-gc-enabled"] input[type="checkbox"]',
    ) as HTMLInputElement;
    box.checked = false;
    box.dispatchEvent(new Event('change'));
    await tick();

    const put = http.expectOne(CONFIG_URL);
    expect(put.request.method).toBe('PUT');
    expect(put.request.body).toEqual({ enabled: false });
    put.flush({ ok: true, config: { ...status.config, enabled: false } });
  });

  it('reads "Not run yet" before the first sweep', async () => {
    await load({
      config: { enabled: true, retention_days: 30, last_run: null },
      rows: 0,
      pruned_through: 0,
    });
    expect(
      (fixture.nativeElement as HTMLElement).querySelector('[data-testid="change-log-gc-summary"]')
        ?.textContent,
    ).toContain('Not run yet');
  });
});
