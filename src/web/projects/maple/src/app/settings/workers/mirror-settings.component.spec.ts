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

  /** Expand the collapsible row so its body renders. */
  const expand = (): void => {
    (el().querySelector('.row-summary') as HTMLElement).click();
    fixture.detectChanges();
  };

  it('shows status + reconcile action in the collapsed summary; body appears on expand', async () => {
    await init();
    // Summary is visible while collapsed: status pill + the reconcile action.
    expect(el().querySelector('[data-testid="mirror-status"]')).not.toBeNull();
    expect(el().querySelector('[data-testid="mirror-reconcile-now"]')).not.toBeNull();
    // The body (stages) is hidden until expanded.
    expect(el().querySelector('[data-testid="mirror-stages"]')).toBeNull();

    expand();
    const stages = el().querySelector('[data-testid="mirror-stages"]');
    expect(stages).not.toBeNull();
    expect(stages?.textContent).toContain('Scanning');
    expect(stages?.textContent).toContain('Copying');
    expect(stages?.textContent).toContain('not run yet');
  });

  it('"Reconcile now" posts and renders the two-stage results + the copied-files log', async () => {
    await init();
    expand();

    el().querySelector<HTMLButtonElement>('[data-testid="mirror-reconcile-now"]')!.click();

    http.expectOne('/api/mirror/reconcile').flush({ started: true, phase: 'scanning' });
    await tick();

    // Return a finished run so no polling interval starts.
    http.expectOne('/api/mirror/status').flush({
      queue: { pending: 0, dead: 0 },
      reconcile: {
        phase: 'idle',
        scan: { scanned: 42, toCopy: 3, upToDate: 39, errors: 0 },
        copy: { total: 3, copied: 3, remaining: 0, errors: 0 },
        currentPath: null,
        startedAt: '2026-06-09T00:00:00Z',
        finishedAt: '2026-06-09T00:00:05Z',
        errorLog: [],
        copiedLog: ['/lib/2024/a.dng', '/lib/2024/b.dng', '/lib/2024/c.dng'],
      },
    });
    await tick();
    fixture.detectChanges();

    const stages = el().querySelector('[data-testid="mirror-stages"]');
    expect(stages?.textContent).toContain('42 scanned');
    expect(stages?.textContent).toContain('3 / 3 copied');

    const copied = el().querySelector('[data-testid="mirror-copied-log"]');
    expect(copied?.textContent).toContain('Copied (3)');
    expect(copied?.textContent).toContain('/lib/2024/a.dng');
    expect(copied?.textContent).toContain('/lib/2024/c.dng');
  });

  it('reflects an in-progress reconcile reported on load (status, current file, copied log)', async () => {
    fixture.detectChanges();
    http.expectOne('/api/folders').flush([]);
    await tick();
    http.expectOne('/api/mirror/status').flush({
      queue: { pending: 6, dead: 0 },
      reconcile: {
        phase: 'copying',
        scan: { scanned: 50, toCopy: 10, upToDate: 40, errors: 0 },
        copy: { total: 10, copied: 4, remaining: 6, errors: 0 },
        currentPath: '/lib/2024/IMG.dng',
        startedAt: '2026-06-09T00:00:00Z',
        finishedAt: null,
        errorLog: [],
        copiedLog: ['/lib/2024/done-1.dng', '/lib/2024/done-2.dng'],
      },
    });
    await tick();
    fixture.detectChanges();

    // Summary status/readout are visible while collapsed.
    expect(el().querySelector('[data-testid="mirror-status"]')?.textContent).toContain('Copying');
    const readout = el().querySelector('[data-testid="mirror-readout"]');
    expect(readout?.textContent).toContain('Copying');
    expect(readout?.textContent).toContain('4/10');

    // Body details show once expanded.
    expand();
    expect(el().querySelector('[data-testid="mirror-current-file"]')?.textContent).toContain(
      '/lib/2024/IMG.dng',
    );
    const copied = el().querySelector('[data-testid="mirror-copied-log"]');
    expect(copied?.textContent).toContain('Copied (2)');
    expect(copied?.textContent).toContain('/lib/2024/done-1.dng');

    // Tear down to clear the resumed poll timer before http.verify().
    fixture.destroy();
  });

  it('renders a copied log with duplicate paths (same primary → multiple mirrors)', async () => {
    await init();
    expand();

    el().querySelector<HTMLButtonElement>('[data-testid="mirror-reconcile-now"]')!.click();
    http.expectOne('/api/mirror/reconcile').flush({ started: true, phase: 'scanning' });
    await tick();

    // The same primary path copied to two mirror locations appears twice — the
    // @for must track by index, not the path string, or change detection throws
    // NG0955 (duplicate keys) here.
    http.expectOne('/api/mirror/status').flush({
      queue: { pending: 0, dead: 0 },
      reconcile: {
        phase: 'idle',
        scan: { scanned: 1, toCopy: 2, upToDate: 0, errors: 0 },
        copy: { total: 2, copied: 2, remaining: 0, errors: 0 },
        currentPath: null,
        startedAt: '2026-06-09T00:00:00Z',
        finishedAt: '2026-06-09T00:00:01Z',
        errorLog: [],
        copiedLog: ['/lib/2024/dup.dng', '/lib/2024/dup.dng'],
      },
    });
    await tick();
    fixture.detectChanges();

    const copied = el().querySelector('[data-testid="mirror-copied-log"]');
    expect(copied?.textContent).toContain('Copied (2)');
    expect(copied?.querySelectorAll('.copied-line').length).toBe(2);
  });

  it('surfaces a backup benched for reads, and nothing when none is', async () => {
    await init();
    expand();
    // Healthy: no benched-reads block at all.
    expect(el().querySelector('[data-testid="mirror-reads-benched"]')).toBeNull();

    el().querySelector<HTMLButtonElement>('[data-testid="mirror-reconcile-now"]')!.click();
    http.expectOne('/api/mirror/reconcile').flush({ started: true, phase: 'idle' });
    await tick();
    http.expectOne('/api/mirror/status').flush({
      queue: { pending: 0, dead: 0 },
      reads: { benched: [{ root: '/mnt/backup/photos', retryInMs: 42_000 }] },
    });
    await tick();
    fixture.detectChanges();

    const benched = el().querySelector('[data-testid="mirror-reads-benched"]');
    expect(benched?.textContent).toContain('/mnt/backup/photos');
    expect(benched?.textContent).toContain('retrying in 42s');
    // The operator must not read this as "backups stopped".
    expect(benched?.textContent).toContain('Backups still queue and retry');
  });
});
