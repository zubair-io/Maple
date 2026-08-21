import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { provideRouter } from '@angular/router';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { API_BASE_URL, type GeneratedSearchConfig } from '@maple-common';
import { GeneratedSearchSettingsComponent } from './generated-search-settings.component';

const CONFIG_URL = '/api/workers/generated-search/config';

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
    http.verify();
  });

  /** Flush the initial GET and let the component's async `reload()` settle.
   * Without the `whenStable()` the assertions run before the awaited
   * promise resolves and every readout is still in its loading state. */
  async function flushConfig(config: GeneratedSearchConfig = paused): Promise<void> {
    http.expectOne(CONFIG_URL).flush(config);
    await fixture.whenStable();
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
