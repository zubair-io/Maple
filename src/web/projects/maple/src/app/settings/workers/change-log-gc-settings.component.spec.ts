import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { API_BASE_URL } from '@maple-common';
import { ChangeLogGcSettingsComponent } from './change-log-gc-settings.component';

const RETENTION_URL = '/api/workers/change-log-gc/retention-window';
const RUN_URL = '/api/workers/change-log-gc/run';

describe('ChangeLogGcSettingsComponent (#3741)', () => {
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

  const expandRow = (): void => {
    (fixture.nativeElement.querySelector('.header') as HTMLElement).click();
    fixture.detectChanges();
  };

  it('fetches retention window on init and renders summary readout', async () => {
    const req = http.expectOne(RETENTION_URL);
    expect(req.request.method).toBe('GET');
    req.flush({ days: 30 });
    await tick();
    fixture.detectChanges();

    const el = fixture.nativeElement as HTMLElement;
    expect(el.querySelector('[data-testid="change-log-gc-status"]')?.textContent).toContain(
      'active',
    );
    expect(el.querySelector('[data-testid="change-log-gc-summary"]')?.textContent).toContain(
      '30 days retention',
    );
  });

  it('updates retention window on Save changes', async () => {
    http.expectOne(RETENTION_URL).flush({ days: 30 });
    await tick();
    fixture.detectChanges();

    expandRow();
    const el = fixture.nativeElement as HTMLElement;
    const input = el.querySelector(
      '[data-testid="change-log-gc-retention-input"] input',
    ) as HTMLInputElement;
    expect(input.value).toBe('30');

    // Change input to 60 days
    input.value = '60';
    input.dispatchEvent(new Event('input'));
    fixture.detectChanges();

    const saveBtn = el.querySelector(
      '[data-testid="change-log-gc-save"] button',
    ) as HTMLButtonElement;
    expect(saveBtn.disabled).toBe(false);
    saveBtn.click();
    fixture.detectChanges();

    const patchReq = http.expectOne(RETENTION_URL);
    expect(patchReq.request.method).toBe('PATCH');
    expect(patchReq.request.body).toEqual({ days: 60 });
    patchReq.flush({ ok: true, days: 60 });
    await tick();
    fixture.detectChanges();

    expect(el.querySelector('[data-testid="change-log-gc-summary"]')?.textContent).toContain(
      '60 days retention',
    );
  });

  it('triggers on-demand sweep via Run now and updates last sweep readout', async () => {
    http.expectOne(RETENTION_URL).flush({ days: 30 });
    await tick();
    fixture.detectChanges();

    const el = fixture.nativeElement as HTMLElement;
    const runBtn = el.querySelector(
      '[data-testid="change-log-gc-run-now"] button',
    ) as HTMLButtonElement;
    runBtn.click();
    fixture.detectChanges();

    const runReq = http.expectOne(RUN_URL);
    expect(runReq.request.method).toBe('POST');
    runReq.flush({ ok: true, deleted: 1500, batches: 2, durationMs: 45 });
    await tick();
    fixture.detectChanges();

    expect(el.querySelector('[data-testid="change-log-gc-summary"]')?.textContent).toContain(
      '1500 pruned (45ms)',
    );

    expandRow();
    expect(el.querySelector('[data-testid="change-log-gc-last-run"]')?.textContent).toContain(
      '1500 deleted in 2 batches (45ms)',
    );
  });

  it('displays error message when run fails', async () => {
    http.expectOne(RETENTION_URL).flush({ days: 30 });
    await tick();
    fixture.detectChanges();

    const el = fixture.nativeElement as HTMLElement;
    const runBtn = el.querySelector(
      '[data-testid="change-log-gc-run-now"] button',
    ) as HTMLButtonElement;
    runBtn.click();
    fixture.detectChanges();

    http.expectOne(RUN_URL).flush('Internal server error', {
      status: 500,
      statusText: 'Server Error',
    });
    await tick();
    fixture.detectChanges();

    expandRow();
    expect(el.querySelector('[data-testid="change-log-gc-error"]')?.textContent).toBeTruthy();
  });
});
