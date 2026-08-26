// ImportsComponent — the browse → scan → edit-buckets → import/progress
// state machine (ticket #742). The transitions are the point: pick a
// library, browse the filesystem, scan a folder into YEAR/MM buckets,
// review/edit labels, queue the import, and watch its progress — including
// the `?job=<id>` deep link that skips straight to the progress step.
//
// ImportsApiService, FilesystemBrowseService, and BunApiBackendService are
// all thin HttpClient wrappers (providedIn: 'root'), so — like
// workers.component.spec.ts — they're left real and driven through
// HttpTestingController rather than stubbed. Every component method here
// awaits `firstValueFrom(...)`, so state updates land one microtask AFTER
// the matching `flush()` — tests await a `Promise.resolve()` tick before
// asserting on the result. Angular's default HttpUrlEncodingCodec leaves
// `/` unescaped in query values, so URLs below use a literal `/`, not `%2F`.

import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { ActivatedRoute, convertToParamMap, provideRouter } from '@angular/router';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  API_BASE_URL,
  type ApiFolder,
  type FsDirListing,
  type ImportScanResult,
} from '@maple-common';
import { ImportsComponent } from './imports.component';

describe('ImportsComponent', () => {
  let fixture: ComponentFixture<ImportsComponent>;
  let component: ImportsComponent;
  let http: HttpTestingController;

  const LIB: ApiFolder = {
    id: 'lib1',
    path: '/photos/library',
    label: 'Main Library',
    last_scan: null,
    file_count: 100,
    created_at: '2026-01-01T00:00:00Z',
  };

  const ROOT_LISTING: FsDirListing = {
    path: '/',
    parent: null,
    dirs: [{ name: 'incoming', path: '/incoming', mtime: '2026-08-01T00:00:00Z' }],
    images: [],
  };

  const RUNNING_IMPORT = {
    id: 'imp1',
    status: 'running',
    source_root: '/incoming',
    library_id: 'lib1',
    library_root: '/photos/library',
    scan_pending: false,
    progress: { current: 25, total: 100 },
    counts: { copied: 20, skipped: 5, failed: 0 },
    error: null,
    cancel_requested: false,
    created_at: '2026-08-01T00:00:00Z',
    updated_at: '2026-08-01T00:00:00Z',
  };

  async function setup(jobId?: string): Promise<void> {
    TestBed.resetTestingModule();
    await TestBed.configureTestingModule({
      imports: [ImportsComponent],
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        provideRouter([]),
        { provide: API_BASE_URL, useValue: '/api' },
        {
          provide: ActivatedRoute,
          useValue: {
            snapshot: { queryParamMap: convertToParamMap(jobId ? { job: jobId } : {}) },
          },
        },
      ],
    }).compileComponents();
    fixture = TestBed.createComponent(ImportsComponent);
    component = fixture.componentInstance;
    http = TestBed.inject(HttpTestingController);
  }

  beforeEach(() => setup());
  afterEach(() => http.verify());

  const el = (): HTMLElement => fixture.nativeElement as HTMLElement;
  const tick = (): Promise<void> => Promise.resolve();
  /** One real macrotask turn — lets an RxJS `asyncScheduler`-based timer
   * (registered during a microtask) actually fire. */
  const macrotask = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

  /** Init + pick the library + land the picker at the filesystem root. */
  async function initAndPickLibrary(): Promise<void> {
    fixture.detectChanges();
    http.expectOne('/api/folders').flush([LIB]);
    http.expectOne('/api/fs/roots').flush({ roots: ['/'] });
    // ngOnInit awaits `Promise.all([...])` — that resolution chain needs two
    // microtask hops (each input promise's `.then`, then the aggregate
    // promise's `.then`) before `this.libraries`/`this.roots` are set.
    await tick();
    await tick();
    fixture.detectChanges();

    const select = el().querySelector<HTMLSelectElement>('.lib-select')!;
    select.value = 'lib1';
    select.dispatchEvent(new Event('change'));
    fixture.detectChanges();

    http.expectOne('/api/fs/dir-fast?path=/').flush(ROOT_LISTING);
    await tick();
    fixture.detectChanges();
  }

  it('GETs /api/folders and /api/fs/roots on init and populates the library select', async () => {
    fixture.detectChanges();
    http.expectOne('/api/folders').flush([LIB]);
    http.expectOne('/api/fs/roots').flush({ roots: ['/'] });
    await tick();
    await tick();
    fixture.detectChanges();

    const options = el().querySelectorAll('.lib-select option');
    // The disabled placeholder + one option per library.
    expect(options.length).toBe(2);
    expect(el().textContent).toContain('Main Library');
  });

  it('choosing a library opens the picker at the filesystem root', async () => {
    await initAndPickLibrary();
    expect(el().textContent).toContain('incoming');
    expect(el().querySelector('.path')?.textContent).toBe('/');
  });

  it('clicking a subfolder browses into it, and Up returns to the parent', async () => {
    await initAndPickLibrary();
    el().querySelector<HTMLButtonElement>('.row-btn button')!.click();

    http
      .expectOne('/api/fs/dir-fast?path=/incoming')
      .flush({ path: '/incoming', parent: '/', dirs: [], images: [] });
    await tick();
    fixture.detectChanges();
    expect(el().querySelector('.path')?.textContent).toBe('/incoming');

    el().querySelector<HTMLButtonElement>('.browser-bar mui-button button')!.click();
    http.expectOne('/api/fs/dir-fast?path=/').flush(ROOT_LISTING);
    await tick();
    fixture.detectChanges();
    expect(el().querySelector('.path')?.textContent).toBe('/');
  });

  it('"Use this folder" is disabled inside the target library and picks the folder outside it', async () => {
    await initAndPickLibrary();
    // At '/', not inside '/photos/library' — usable.
    const useBtn = el().querySelector<HTMLButtonElement>('.use-here button')!;
    expect(useBtn.disabled).toBe(false);

    useBtn.click();
    fixture.detectChanges();

    expect(el().querySelector('.picked-row code')?.textContent).toBe('/');
    expect(
      el().querySelector('.actions mui-button[variant="primary"]')?.textContent,
    ).toContain('Pick Folder Name(s)');
  });

  it('runScan POSTs /api/imports/scan and transitions to the review step with buckets rendered', async () => {
    await initAndPickLibrary();
    el().querySelector<HTMLButtonElement>('.use-here button')!.click();
    fixture.detectChanges();

    el().querySelector<HTMLButtonElement>('.actions mui-button[variant="primary"] button')!.click();
    const req = http.expectOne('/api/imports/scan');
    expect(req.request.method).toBe('POST');
    expect(req.request.body).toEqual({ source_root: '/', library_id: 'lib1' });

    const scanResult: ImportScanResult = {
      source_root: '/',
      buckets: [
        {
          key: '2026/07',
          year: '2026',
          mm: '07',
          fileCount: 3,
          imageCount: 3,
          movieCount: 0,
          sidecarCount: 0,
          totalBytes: 1000,
          defaultDest: '2026/07',
          nearbyMatchCount: 0,
          nearbyMatchFolders: [],
        },
      ],
      totals: { files: 3, images: 3, movies: 0, sidecars: 0, bytes: 1000 },
    };
    req.flush(scanResult);
    await tick();
    fixture.detectChanges();

    expect(el().textContent).toContain('3 · Review groups');
    expect(el().querySelectorAll('.bucket-row').length).toBe(1);
    expect(el().querySelector('.dest-preview code')?.textContent).toBe('2026/07');
  });

  it('runScan with zero files shows an error and stays on the pick step', async () => {
    await initAndPickLibrary();
    el().querySelector<HTMLButtonElement>('.use-here button')!.click();
    fixture.detectChanges();
    el().querySelector<HTMLButtonElement>('.actions mui-button[variant="primary"] button')!.click();

    http.expectOne('/api/imports/scan').flush({
      source_root: '/',
      buckets: [],
      totals: { files: 0, images: 0, movies: 0, sidecars: 0, bytes: 0 },
    });
    await tick();
    fixture.detectChanges();

    expect(el().querySelector('.error')?.textContent).toContain(
      'No importable photos, sidecars, or movies in that folder.',
    );
    expect(el().querySelector('.bucket-table')).toBeNull();
  });

  /** Drive all the way to the review step with one bucket. */
  async function toReviewStep(): Promise<void> {
    await initAndPickLibrary();
    el().querySelector<HTMLButtonElement>('.use-here button')!.click();
    fixture.detectChanges();
    el().querySelector<HTMLButtonElement>('.actions mui-button[variant="primary"] button')!.click();
    http.expectOne('/api/imports/scan').flush({
      source_root: '/',
      buckets: [
        {
          key: '2026/07',
          year: '2026',
          mm: '07',
          fileCount: 3,
          imageCount: 3,
          movieCount: 0,
          sidecarCount: 0,
          totalBytes: 1000,
          defaultDest: '2026/07',
          nearbyMatchCount: 1,
          nearbyMatchFolders: ['2026/06/trip'],
        },
      ],
      totals: { files: 3, images: 3, movies: 0, sidecars: 0, bytes: 1000 },
    } satisfies ImportScanResult);
    await tick();
    fixture.detectChanges();
  }

  it('editing a bucket label overrides the destination preview and hides the nearby-match note', async () => {
    await toReviewStep();
    expect(el().querySelector('.nearby-note')).toBeTruthy();

    const labelInput = el().querySelector<HTMLInputElement>('.label-input input')!;
    labelInput.value = 'summer-trip';
    labelInput.dispatchEvent(new Event('input'));
    fixture.detectChanges();

    expect(el().querySelector('.dest-preview code')?.textContent).toBe('2026/summer-trip');
    expect(el().querySelector('.nearby-note')).toBeNull();
  });

  it('startImport POSTs the reviewed labels and returns to pick with the queued notice', async () => {
    await toReviewStep();
    const labelInput = el().querySelector<HTMLInputElement>('.label-input input')!;
    labelInput.value = 'summer-trip';
    labelInput.dispatchEvent(new Event('input'));
    fixture.detectChanges();

    el().querySelector<HTMLButtonElement>('.actions mui-button[variant="primary"] button')!.click();
    const req = http.expectOne('/api/imports');
    expect(req.request.method).toBe('POST');
    expect(req.request.body).toEqual({
      source_root: '/',
      library_id: 'lib1',
      labels: { '2026/07': 'summer-trip' },
    });
    req.flush({ id: 'imp1' });
    await tick();
    fixture.detectChanges();

    expect(el().querySelector('[role="status"]')?.textContent).toContain('Import queued');
    expect(el().querySelector('.bucket-table')).toBeNull();
  });

  it('Auto Import queues immediately (auto:true, no scan) and shows the "(auto)" notice', async () => {
    await initAndPickLibrary();
    el().querySelector<HTMLButtonElement>('.use-here button')!.click();
    fixture.detectChanges();

    const autoBtn = Array.from(el().querySelectorAll<HTMLButtonElement>('.actions button')).find(
      (b) => b.textContent?.includes('Auto Import'),
    )!;
    autoBtn.click();

    const req = http.expectOne('/api/imports');
    expect(req.request.body).toEqual({ source_root: '/', library_id: 'lib1', auto: true });
    req.flush({ id: 'imp2' });
    await tick();
    fixture.detectChanges();

    expect(el().querySelector('[role="status"]')?.textContent).toContain('(auto)');
  });

  it('a ?job= deep link starts on the progress step and polls the import status', async () => {
    await setup('imp1');
    fixture.detectChanges();
    http.expectOne('/api/folders').flush([LIB]);
    http.expectOne('/api/fs/roots').flush({ roots: ['/'] });
    // One macrotask turn lands ngOnInit's `Promise.all` continuation
    // (including the `startPolling` call); a second lets the freshly
    // registered `timer(0, 1500)` itself fire and issue the poll GET.
    await macrotask();
    await macrotask();
    fixture.detectChanges();

    expect(el().textContent).toContain('Importing');
    const req = http.expectOne('/api/imports/imp1?summary=1');
    expect(req.request.method).toBe('GET');
    req.flush(RUNNING_IMPORT);
    await tick();
    fixture.detectChanges();

    expect(el().querySelector('.pct')?.textContent).toBe('25%');
    expect(el().textContent).toContain('25 / 100 files');
    expect(el().textContent).toContain('20 copied');

    component.ngOnDestroy(); // stop the poll before teardown
  });

  it('Cancel POSTs /api/imports/{id}/cancel while an import is running', async () => {
    await setup('imp1');
    fixture.detectChanges();
    http.expectOne('/api/folders').flush([LIB]);
    http.expectOne('/api/fs/roots').flush({ roots: ['/'] });
    await macrotask();
    await macrotask();
    http.expectOne('/api/imports/imp1?summary=1').flush(RUNNING_IMPORT);
    await tick();
    fixture.detectChanges();

    el().querySelector<HTMLButtonElement>('.actions mui-button[variant="ghost"] button')!.click();
    const req = http.expectOne('/api/imports/imp1/cancel');
    expect(req.request.method).toBe('POST');
    req.flush({ ok: true });

    component.ngOnDestroy();
  });

  it('shows the scan-error message and stays on the pick step when the scan request fails', async () => {
    await initAndPickLibrary();
    el().querySelector<HTMLButtonElement>('.use-here button')!.click();
    fixture.detectChanges();
    el().querySelector<HTMLButtonElement>('.actions mui-button[variant="primary"] button')!.click();

    http
      .expectOne('/api/imports/scan')
      .flush({ error: 'permission denied' }, { status: 403, statusText: 'Forbidden' });
    await tick();
    fixture.detectChanges();

    expect(el().querySelector('.error')?.textContent).toContain('permission denied');
    expect(el().querySelector('.bucket-table')).toBeNull();
  });
});
