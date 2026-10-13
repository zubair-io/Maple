import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { provideRouter } from '@angular/router';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  API_BASE_URL,
  type GeneratedSearchConfig,
  type GeneratedSearchLastRun,
} from '@maple-common';
import { GeneratedSearchSettingsComponent } from './generated-search-settings.component';

const CONFIG_URL = '/api/workers/generated-search/config';
const LAST_RUN_URL = '/api/workers/generated-search/last-run';

const paused: GeneratedSearchConfig = {
  collections_per_day: 4,
  min_results: 8,
  max_rounds: 3,
  retention_days: 30,
  model: '',
  paused: true,
  dry_run: false,
};

describe('GeneratedSearchSettingsComponent', () => {
  let fixture: ComponentFixture<GeneratedSearchSettingsComponent>;
  let http: HttpTestingController;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [GeneratedSearchSettingsComponent],
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        provideRouter([]),
        { provide: API_BASE_URL, useValue: '/api' },
      ],
    }).compileComponents();

    fixture = TestBed.createComponent(GeneratedSearchSettingsComponent);
    http = TestBed.inject(HttpTestingController);
    fixture.detectChanges();
  });

  afterEach(() => {
    for (const request of http.match('/api/ai/connections/'))
      request.flush({ connections: [], assignments: {}, available_workers: [] });
    http.verify();
  });

  /** Flush the initial GET and let the component's async `reload()` settle.
   * Without the `whenStable()` the assertions run before the awaited
   * promise resolves and every readout is still in its loading state. */
  async function flushConfig(
    config: GeneratedSearchConfig = paused,
    lastRun: GeneratedSearchLastRun | null = null,
  ): Promise<void> {
    http.expectOne(CONFIG_URL).flush(config);
    await fixture.whenStable();
    http.expectOne(LAST_RUN_URL).flush({ last_run: lastRun });
    // The panel resolves which library to read collections for; with no
    // folders registered it stops there and never asks for collections.
    for (const r of http.match('/api/folders')) r.flush([]);
    await fixture.whenStable();
    fixture.detectChanges();
  }

  /** Expand the row so the body (toggle, knobs, collections) is rendered. */
  function expand(): void {
    const row = fixture.nativeElement.querySelector('[data-testid="generated-search-row"]');
    row.querySelector('.wrow-summary').click();
    fixture.detectChanges();
  }

  it('reads the worker as paused until an operator enables it', async () => {
    await flushConfig();
    // The worker ships paused because it calls an LLM and publishes to a
    // widget; the panel must not imply it is already running.
    expect(fixture.nativeElement.textContent).toContain('paused');
  });

  it('reports a running worker once paused clears', async () => {
    await flushConfig({ ...paused, paused: false });
    expect(fixture.nativeElement.textContent).toContain('running');
  });

  it('sends only the paused flag when toggling, leaving the knobs alone', async () => {
    await flushConfig();
    expand();

    const toggle: HTMLInputElement = fixture.nativeElement.querySelector('input[type="checkbox"]');
    toggle.click();
    fixture.detectChanges();

    const req = http.expectOne(CONFIG_URL);
    expect(req.request.method).toBe('PATCH');
    // A toggle must not silently commit a half-edited draft.
    expect(req.request.body).toEqual({ paused: false });
    req.flush({ ok: true, config: { ...paused, paused: false } });
  });

  it('adopts the server’s stored config rather than the optimistic local value', async () => {
    await flushConfig();
    expand();

    const toggle: HTMLInputElement = fixture.nativeElement.querySelector('input[type="checkbox"]');
    toggle.click();
    fixture.detectChanges();

    // Server clamps; the panel must show what was stored, not what was asked.
    http
      .expectOne(CONFIG_URL)
      .flush({ ok: true, config: { ...paused, paused: false, collections_per_day: 12 } });
    await fixture.whenStable();
    fixture.detectChanges();

    expect(fixture.nativeElement.textContent).toContain('running');
  });

  it('says the job has never run before its first attempt', async () => {
    await flushConfig({ ...paused, paused: false });
    expand();
    const line = fixture.nativeElement.querySelector('[data-testid="gs-last-run"]');
    expect(line.textContent).toContain('never run');
  });

  it('shows a failed last run in the row and the panel so a stall is visible', async () => {
    await flushConfig(
      { ...paused, paused: false },
      {
        library_id: 'lib',
        claim_id: 'claim',
        day: '2026-10-12',
        attempts: 1,
        started_at: '2026-10-12T06:00:00.000Z',
        finished_at: '2026-10-12T06:01:00.000Z',
        outcome: 'failed',
        saved: 0,
        error: 'ollama unreachable',
        trigger: 'schedule',
      },
    );
    const summary = fixture.nativeElement.querySelector('[data-testid="gs-summary"]');
    expect(summary.textContent).toContain('last run failed');

    expand();
    const line = fixture.nativeElement.querySelector('[data-testid="gs-last-run"]');
    expect(line.textContent).toContain('failed: ollama unreachable');
    expect(line.textContent).toContain(new Date('2026-10-12T06:00:00.000Z').toLocaleString());
  });

  it('surfaces a config load failure instead of rendering an empty panel', async () => {
    http.expectOne(CONFIG_URL).flush('nope', { status: 500, statusText: 'Server Error' });
    await fixture.whenStable();
    for (const r of http.match('/api/folders')) r.flush([]);
    await fixture.whenStable();
    fixture.detectChanges();
    expand();

    expect(fixture.nativeElement.querySelector('[role="alert"]')).toBeTruthy();
  });
});

describe('GeneratedSearchSettingsComponent — Run now', () => {
  let fixture: ComponentFixture<GeneratedSearchSettingsComponent>;
  let http: HttpTestingController;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [GeneratedSearchSettingsComponent],
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        provideRouter([]),
        { provide: API_BASE_URL, useValue: '/api' },
      ],
    }).compileComponents();
    fixture = TestBed.createComponent(GeneratedSearchSettingsComponent);
    http = TestBed.inject(HttpTestingController);
    fixture.detectChanges();
  });

  afterEach(() => {
    for (const request of http.match('/api/ai/connections/'))
      request.flush({ connections: [], assignments: {}, available_workers: [] });
    http.verify();
  });

  it('POSTs the run endpoint and disables the button while in flight', async () => {
    http.expectOne(CONFIG_URL).flush(paused);
    await fixture.whenStable();
    http.expectOne(LAST_RUN_URL).flush({ last_run: null });
    for (const r of http.match('/api/folders')) r.flush([]);
    await fixture.whenStable();
    fixture.detectChanges();

    // Zero the post-kick wait so the spec doesn't sleep wall-clock.
    (fixture.componentInstance as unknown as { refreshDelayMs: number }).refreshDelayMs = 0;
    const button: HTMLButtonElement = fixture.nativeElement.querySelector(
      '[data-testid="gs-run-now"] button',
    );
    button.click();
    fixture.detectChanges();
    expect(button.disabled).toBe(true);

    const req = http.expectOne('/api/workers/generated-search/run');
    expect(req.request.method).toBe('POST');
    // already-running takes the same refresh path as started: a pass is in
    // flight either way, so the list still reloads and no error surfaces.
    req.flush({ started: false, reason: 'already-running' });
    await new Promise((r) => setTimeout(r, 0));
    for (const r of http.match((rq) => rq.url.includes('/api/generated-searches')))
      r.flush({ results: [] });
    for (const r of http.match(LAST_RUN_URL)) r.flush({ last_run: null });
    await fixture.whenStable();
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('[role="alert"]')).toBeNull();
  });
});
