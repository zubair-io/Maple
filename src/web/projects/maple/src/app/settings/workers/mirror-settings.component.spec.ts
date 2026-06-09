import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { API_BASE_URL } from '@maple-common';
import { MirrorSettingsComponent } from './mirror-settings.component';

describe('MirrorSettingsComponent', () => {
  let fixture: ComponentFixture<MirrorSettingsComponent>;
  let http: HttpTestingController;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [MirrorSettingsComponent],
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        { provide: API_BASE_URL, useValue: '/api' },
      ],
    }).compileComponents();
    fixture = TestBed.createComponent(MirrorSettingsComponent);
    http = TestBed.inject(HttpTestingController);
  });

  afterEach(() => http.verify());

  /** Drain microtasks (firstValueFrom → ngOnInit continuation) via a macrotask. */
  const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

  /** Drive ngOnInit: it fetches the library list then the queue status. */
  async function init(): Promise<void> {
    fixture.detectChanges();
    http.expectOne('/api/folders').flush([]);
    await tick(); // let the init continuation fire the status GET
    http.expectOne('/api/mirror/status').flush({ queue: { pending: 0, dead: 0 } });
    await tick();
    fixture.detectChanges();
  }

  const el = (): HTMLElement => fixture.nativeElement as HTMLElement;

  it('is collapsed by default — config hidden, aria-expanded=false', async () => {
    await init();
    expect(el().querySelector('.expanded')).toBeNull();
    expect(el().querySelector('.row-summary')?.getAttribute('aria-expanded')).toBe('false');
  });

  it('expands the config when the row summary is clicked', async () => {
    await init();
    el().querySelector<HTMLElement>('.row-summary')!.click();
    fixture.detectChanges();

    expect(el().querySelector('.expanded')).not.toBeNull();
    expect(el().querySelector('.row-summary')?.getAttribute('aria-expanded')).toBe('true');

    // Toggling again collapses it.
    el().querySelector<HTMLElement>('.row-summary')!.click();
    fixture.detectChanges();
    expect(el().querySelector('.expanded')).toBeNull();
  });

  it('"Scan now" posts a scan and renders the returned progress', async () => {
    await init();
    el().querySelector<HTMLElement>('.row-summary')!.click(); // expand
    fixture.detectChanges();

    el().querySelector<HTMLButtonElement>('[data-testid="mirror-scan-now"]')!.click();

    http.expectOne('/api/mirror/scan-now').flush({ started: true, phase: 'scanning' });
    await tick(); // let scanNow continue into refreshStatus

    // Return an already-finished pass so no polling interval starts.
    http.expectOne('/api/mirror/status').flush({
      queue: { pending: 3, dead: 0 },
      scan: {
        phase: 'idle',
        scanned: 42,
        enqueued: 3,
        upToDate: 39,
        currentPath: null,
        startedAt: '2026-06-08T00:00:00Z',
        finishedAt: '2026-06-08T00:00:01Z',
        error: null,
      },
    });
    await tick();
    fixture.detectChanges();

    const stats = el().querySelector('[data-testid="mirror-scan-stats"]');
    expect(stats?.textContent).toContain('42 checked');
    expect(stats?.textContent).toContain('3 queued');
  });

  it('reflects an in-progress scan reported on load (collapsed indicator)', async () => {
    fixture.detectChanges();
    http.expectOne('/api/folders').flush([]);
    await tick();
    // Status reports a scan already running server-side (e.g. started before reload).
    http.expectOne('/api/mirror/status').flush({
      queue: { pending: 5, dead: 0 },
      scan: {
        phase: 'scanning',
        scanned: 17,
        enqueued: 5,
        upToDate: 12,
        currentPath: '/lib/2024/IMG.dng',
        startedAt: '2026-06-09T00:00:00Z',
        finishedAt: null,
        error: null,
      },
    });
    await tick();
    fixture.detectChanges();

    // The collapsed summary surfaces the running scan without expanding.
    const indicator = el().querySelector('[data-testid="mirror-scan-indicator"]');
    expect(indicator?.textContent).toContain('Scanning');
    expect(indicator?.textContent).toContain('17');

    // Tear down to clear the resumed poll timer before http.verify().
    fixture.destroy();
  });
});
