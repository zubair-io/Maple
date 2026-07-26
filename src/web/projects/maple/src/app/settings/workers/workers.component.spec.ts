import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideHttpClientTesting, HttpTestingController } from '@angular/common/http/testing';
import { provideHttpClient } from '@angular/common/http';
import { provideRouter } from '@angular/router';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Subject } from 'rxjs';
import { WorkersComponent } from './workers.component';
import { API_BASE_URL, WorkerEventsService } from '@maple-common';
import type {
  WorkersStatusResponse,
  WorkersStatusUpdate,
  EnrichmentConfigResponse,
} from '@maple-common';

const wsFrames = new Subject<WorkersStatusUpdate>();
const workerEventsStub: Pick<WorkerEventsService, 'workersStatus$'> = {
  workersStatus$: wsFrames.asObservable(),
};

const MOCK_CONFIG = {
  concurrency: 4,
  maxAttempts: 5,
  paused: false,
  last_seen_target_version: 1,
};

const MOCK_STATUS: WorkersStatusResponse = {
  stages: [
    {
      name: 'hash',
      status: 'running',
      inFlight: 3,
      configured: 4,
      pending: 1247,
      ready: 1247,
      blocked: 0,
      dead: 0,
      throughput: 18,
      lastError: null,
      config: MOCK_CONFIG,
      batchSize: 10,
    },
    {
      name: 'preview',
      status: 'running',
      inFlight: 2,
      configured: 4,
      pending: 500,
      ready: 500,
      blocked: 0,
      dead: 0,
      throughput: 12,
      lastError: null,
      config: MOCK_CONFIG,
      batchSize: 10,
    },
    {
      name: 'face-detect',
      status: 'running',
      inFlight: 1,
      configured: 2,
      pending: 842,
      ready: 800,
      blocked: 42,
      dead: 3,
      throughput: 6,
      lastError: null,
      config: {
        concurrency: 2,
        maxAttempts: 5,
        paused: false,
        last_seen_target_version: 1,
      },
      batchSize: 10,
    },
    {
      name: 'describe',
      status: 'error',
      inFlight: 0,
      configured: 2,
      pending: 842,
      ready: 0,
      blocked: 842,
      dead: 0,
      throughput: 0,
      lastError: 'API key invalid',
      config: {
        concurrency: 2,
        maxAttempts: 5,
        paused: false,
        last_seen_target_version: 1,
      },
      batchSize: 10,
    },
  ],
};

const MOCK_ENRICHMENT: EnrichmentConfigResponse = {
  nominatim_url: null,
  geocode_worker_enabled: true,
  nominatim_rate_limit_per_sec: 10,
  describe_worker_enabled: true,
  describe_provider: 'ollama',
  describe_provider_url: null,
  describe_model: 'qwen3-vl:8b',
  describe_system_prompt: '',
  describe_daily_cap_usd: 0,
  transcribe_model_tier: 'medium.en',
  face_worker_enabled: false,
  face_model_dir: '/tmp/.maple/models',
  face_detector_url: null,
  face_detector_sha256: null,
  face_recognizer_url: null,
  face_recognizer_sha256: null,
  face_min_detection_size: 0.06,
  meilisearch_url: null,
  meilisearch_api_key_set: false,
  meilisearch_task_timeout_seconds: 600,
  meilisearch_semantic_enabled: false,
  meilisearch_embedder_url: 'http://localhost:11434',
  meilisearch_embedder_model: 'bge-m3',
  meilisearch_semantic_ratio: 0.5,
  service_search_rate_limit_per_minute: 60,
  source: {
    nominatim_url: 'unset',
    geocode_worker_enabled: 'default',
    nominatim_rate_limit_per_sec: 'default',
    describe_worker_enabled: 'default',
    describe_provider: 'default',
    describe_provider_url: 'unset',
    describe_model: 'default',
    describe_system_prompt: 'default',
    describe_daily_cap_usd: 'default',
    transcribe_model_tier: 'default',
    face_worker_enabled: 'default',
    face_model_dir: 'default',
    face_detector_url: 'unset',
    face_detector_sha256: 'unset',
    face_recognizer_url: 'unset',
    face_recognizer_sha256: 'unset',
    face_min_detection_size: 'default',
    meilisearch_url: 'unset',
    meilisearch_api_key: 'unset',
    meilisearch_task_timeout_seconds: 'default',
    meilisearch_semantic_enabled: 'default',
    meilisearch_embedder_url: 'default',
    meilisearch_embedder_model: 'default',
    meilisearch_semantic_ratio: 'default',
    service_search_rate_limit_per_minute: 'default',
  },
};

describe('WorkersComponent', () => {
  let fixture: ComponentFixture<WorkersComponent>;
  let component: WorkersComponent;
  let http: HttpTestingController;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [WorkersComponent],
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        provideRouter([]),
        { provide: API_BASE_URL, useValue: '/api' },
        { provide: WorkerEventsService, useValue: workerEventsStub },
      ],
    }).compileComponents();
    fixture = TestBed.createComponent(WorkersComponent);
    component = fixture.componentInstance;
    http = TestBed.inject(HttpTestingController);
  });

  afterEach(() => {
    component.ngOnDestroy();
    // The Imports group + the embedded Backup (mirror) panel fetch the library
    // list on init, and the mirror panel also polls queue status; flush any
    // pending so verify() — which asserts no open requests — doesn't trip.
    for (const r of http.match('/api/folders')) r.flush([]);
    for (const r of http.match('/api/mirror/status')) r.flush({ queue: { pending: 0, dead: 0 } });
    for (const r of http.match((req) => req.url.includes('/api/photos/hidden'))) r.flush([]);
    // Maintenance (derivative-audit) panel fetches status on init; a minimal
    // shape drains the request at teardown (no assertions run on it here).
    for (const r of http.match('/api/derivative-audit/status'))
      r.flush({ config: { enabled: true }, progress: {} });
    http.verify();
  });

  const MOCK_PERF = {
    ffi_workers: 1,
    source: 'default' as const,
    min: 1,
    max: 16,
    pool: { target: 1, spawned: 0, busy: 0, queued: 0 },
  };

  const MOCK_PRUNE = { hours: 24 };

  function initWithMock(): void {
    fixture.detectChanges();
    wsFrames.next({ status: MOCK_STATUS, counted: true });
    http.expectOne('/api/workers/status').flush(MOCK_STATUS);
    http.expectOne('/api/enrichment/config').flush(MOCK_ENRICHMENT);
    http.expectOne('/api/workers/missing-reaper/prune-window').flush(MOCK_PRUNE);
    http.expectOne('/api/workers/performance').flush(MOCK_PERF);
    flushPanelPolls();
    fixture.detectChanges();
  }

  function flushPanelPolls(): void {
    http.expectOne('/api/workers/migration/migrations').flush({ migrations: [] });
    // Both the Imports group and the embedded Backup (mirror) panel fetch /api/folders.
    for (const r of http.match('/api/folders')) r.flush([]);
    for (const r of http.match('/api/mirror/status')) r.flush({ queue: { pending: 0, dead: 0 } });
    http.expectOne('/api/imports?limit=25').flush({ imports: [] });
  }

  it('renders one row per stage from the WS status frame', () => {
    initWithMock();
    const rows = fixture.nativeElement.querySelectorAll('[data-testid="worker-row"]');
    expect(rows.length).toBe(4);
  });

  it('renders Status column correctly', () => {
    initWithMock();
    const rows: NodeListOf<HTMLElement> = fixture.nativeElement.querySelectorAll(
      '[data-testid="worker-row"]',
    );
    // Rows are grouped in pipeline order: hash (Ingest), describe + face (Enrich)
    const hashRow = Array.from(rows).find((r) => r.textContent?.includes('hash'));
    const descRow = Array.from(rows).find((r) => r.textContent?.includes('describe'));
    expect(hashRow?.querySelector('[data-testid="status"]')?.textContent?.trim()).toBe('Running');
    expect(descRow?.querySelector('[data-testid="status"]')?.textContent?.trim()).toBe('Error');
  });

  it('renders Concurrency column as the configured value', () => {
    initWithMock();
    const rows: NodeListOf<HTMLElement> = fixture.nativeElement.querySelectorAll(
      '[data-testid="worker-row"]',
    );
    const hashRow = Array.from(rows).find((r) => r.textContent?.includes('hash'))!;
    expect(hashRow.querySelector('[data-testid="workers"]')?.textContent?.trim()).toBe('4');
  });

  it('renders In flight as inFlight / batchSize', () => {
    initWithMock();
    const rows: NodeListOf<HTMLElement> = fixture.nativeElement.querySelectorAll(
      '[data-testid="worker-row"]',
    );
    const hashRow = Array.from(rows).find((r) => r.textContent?.includes('hash'))!;
    expect(
      hashRow.querySelector('[data-testid="in-flight"]')?.textContent?.replace(/\s+/g, ' ').trim(),
    ).toBe('3 / 10');
  });

  it('renders the ready count with a thousands separator and no blocked suffix when nothing is blocked', () => {
    initWithMock();
    const rows: NodeListOf<HTMLElement> = fixture.nativeElement.querySelectorAll(
      '[data-testid="worker-row"]',
    );
    const hashRow = Array.from(rows).find((r) => r.textContent?.includes('hash'))!;
    expect(hashRow.querySelector('[data-testid="pending-ready"]')?.textContent?.trim()).toBe(
      '1,247',
    );
    expect(hashRow.querySelector('[data-testid="pending-blocked"]')).toBeNull();
  });

  it('renders ready and blocked side by side when a stage has blocked work', () => {
    initWithMock();
    const rows: NodeListOf<HTMLElement> = fixture.nativeElement.querySelectorAll(
      '[data-testid="worker-row"]',
    );
    const faceRow = Array.from(rows).find((r) => r.textContent?.includes('face-detect'))!;
    expect(faceRow.querySelector('[data-testid="pending-ready"]')?.textContent?.trim()).toBe('800');
    expect(
      faceRow
        .querySelector('[data-testid="pending-blocked"]')
        ?.textContent?.replace(/\s+/g, ' ')
        .trim(),
    ).toBe('· 42 blkd');
  });

  it('renders Dead count with retry-affordance icon when dead > 0', () => {
    initWithMock();
    const rows: NodeListOf<HTMLElement> = fixture.nativeElement.querySelectorAll(
      '[data-testid="worker-row"]',
    );
    const faceRow = Array.from(rows).find((r) => r.textContent?.includes('face-detect'))!;
    expect(faceRow.querySelector('[data-testid="dead-count"]')?.textContent?.trim()).toBe('3');

    const hashRow = Array.from(rows).find((r) => r.textContent?.includes('hash'))!;
    expect(hashRow.querySelector('[data-testid="dead-count"]')?.textContent?.trim()).toBe('0');
  });

  it('renders throughput as "n /min" and "—" when zero', () => {
    initWithMock();
    const rows: NodeListOf<HTMLElement> = fixture.nativeElement.querySelectorAll(
      '[data-testid="worker-row"]',
    );
    const hashRow = Array.from(rows).find((r) => r.textContent?.includes('hash'))!;
    const descRow = Array.from(rows).find((r) => r.textContent?.includes('describe'))!;
    expect(hashRow.textContent?.replace(/\s+/g, ' ')).toContain('18 /min');
    // Describe has throughput 0 — em-dash rendered.
    expect(descRow.textContent).toContain('—');
  });

  it('clicking the pause button POSTs /api/workers/{name}/pause', () => {
    initWithMock();
    const rows: NodeListOf<HTMLElement> = fixture.nativeElement.querySelectorAll(
      '[data-testid="worker-row"]',
    );
    const hashRow = Array.from(rows).find((r) => r.textContent?.includes('hash'))!;
    hashRow.querySelector<HTMLButtonElement>('[data-testid="pause-resume-btn"]')?.click();

    http
      .expectOne({ method: 'POST', url: '/api/workers/hash/pause' })
      .flush(null, { status: 204, statusText: '' });
    fixture.detectChanges();
  });

  it('clicking a row expands an inline config panel', () => {
    initWithMock();
    const rows: NodeListOf<HTMLElement> = fixture.nativeElement.querySelectorAll(
      '[data-testid="worker-row"]',
    );
    const hashRow = Array.from(rows).find((r) => r.textContent?.includes('hash'))!;
    // Before click: panel not present.
    expect(hashRow.querySelector('.expanded')).toBeNull();
    // Click the summary row (not the kebab/pause buttons).
    hashRow.querySelector<HTMLElement>('.row-summary')?.click();
    fixture.detectChanges();
    expect(hashRow.querySelector('.expanded')).toBeTruthy();
    // Save + Reset buttons exist in the footer.
    expect(hashRow.querySelector('.btn-primary')?.textContent?.trim()).toContain('Save');
  });

  it('lets the HTTP fallback win after only an uncounted (registry-only) WS frame', () => {
    // The server's initial cheap snapshot: zeroed counts, config:null. It must
    // NOT disable the fallback, or the page would seed forms from defaults.
    const cheap: WorkersStatusResponse = {
      stages: [
        {
          name: 'hash',
          status: 'running',
          inFlight: 0,
          configured: 0,
          pending: 0,
          ready: 0,
          blocked: 0,
          dead: 0,
          throughput: 0,
          lastError: null,
          config: null,
          batchSize: 0,
        },
      ],
    };
    fixture.detectChanges();
    wsFrames.next({ status: cheap, counted: false });
    // Fallback flushes the real status — and because the WS frame was
    // uncounted, the component accepts it instead of ignoring it. Flush the
    // sibling ngOnInit GETs too so verify() is satisfied at teardown.
    http.expectOne('/api/workers/status').flush(MOCK_STATUS);
    http.expectOne('/api/enrichment/config').flush(MOCK_ENRICHMENT);
    http.expectOne('/api/workers/missing-reaper/prune-window').flush(MOCK_PRUNE);
    http.expectOne('/api/workers/performance').flush(MOCK_PERF);
    flushPanelPolls();
    fixture.detectChanges();

    const rows = fixture.nativeElement.querySelectorAll('[data-testid="worker-row"]');
    // The cheap snapshot is replaced by the fallback, so all four stages render.
    expect(rows.length).toBe(4);
    const hashRow = Array.from<HTMLElement>(rows).find((r) => r.textContent?.includes('hash'))!;
    // Real configured value from the fallback, not the cheap snapshot's 0.
    expect(hashRow.querySelector('[data-testid="workers"]')?.textContent?.trim()).toBe('4');
  });

  // ── Open logs drawer ──────────────────────────────────────────────────

  /** Expand a stage row and click its "Open logs" button. */
  function openLogsFor(stageName: string): void {
    const rows: NodeListOf<HTMLElement> = fixture.nativeElement.querySelectorAll(
      '[data-testid="worker-row"]',
    );
    const row = Array.from(rows).find((r) => r.textContent?.includes(stageName))!;
    row.querySelector<HTMLElement>('.row-summary')?.click();
    fixture.detectChanges();
    row.querySelector<HTMLButtonElement>('[data-testid="open-logs-btn"]')?.click();
    fixture.detectChanges();
  }

  it('clicking "Open logs" GETs /api/workers/{name}/dead and renders the drawer', () => {
    initWithMock();
    openLogsFor('face-detect');

    const req = http.expectOne('/api/workers/face-detect/dead?limit=50');
    expect(req.request.method).toBe('GET');
    req.flush({
      items: [
        {
          id: 'abc123',
          abs_path: '/photos/IMG_0001.dng',
          last_error: 'ONNX session crashed',
          attempts: 3,
          processed_at: '2026-05-22T05:00:00Z',
        },
      ],
    });
    fixture.detectChanges();

    const drawer = fixture.nativeElement.querySelector('[data-testid="log-drawer"]');
    expect(drawer).toBeTruthy();
    expect(drawer.getAttribute('aria-modal')).toBe('true');
    expect(drawer.textContent).toContain('/photos/IMG_0001.dng');
    expect(drawer.textContent).toContain('ONNX session crashed');
    expect(drawer.textContent).toContain('3 attempts');
    expect(drawer.textContent).toContain('1 failed job');
  });

  it('shows an empty state when the dead list is empty', () => {
    initWithMock();
    openLogsFor('hash');

    http.expectOne('/api/workers/hash/dead?limit=50').flush({ items: [] });
    fixture.detectChanges();

    const drawer = fixture.nativeElement.querySelector('[data-testid="log-drawer"]');
    expect(drawer.textContent).toContain('No failed jobs for this stage.');
    // Retry-all is hidden when there are no dead items.
    expect(drawer.querySelector('.btn-ghost.danger')).toBeNull();
  });

  it('clicking the backdrop closes the drawer', () => {
    initWithMock();
    openLogsFor('hash');
    http.expectOne('/api/workers/hash/dead?limit=50').flush({ items: [] });
    fixture.detectChanges();

    expect(fixture.nativeElement.querySelector('[data-testid="log-drawer"]')).toBeTruthy();
    (
      fixture.nativeElement.querySelector('[data-testid="log-backdrop"]') as HTMLElement | null
    )?.click();
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('[data-testid="log-drawer"]')).toBeNull();
  });

  it('Escape key closes the drawer', () => {
    initWithMock();
    openLogsFor('hash');
    http.expectOne('/api/workers/hash/dead?limit=50').flush({ items: [] });
    fixture.detectChanges();

    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('[data-testid="log-drawer"]')).toBeNull();
  });

  it('Retry-all in the drawer POSTs retry-dead and closes', () => {
    initWithMock();
    openLogsFor('face-detect');
    http.expectOne('/api/workers/face-detect/dead?limit=50').flush({
      items: [{ id: 'a', abs_path: '/a.dng', last_error: 'x', attempts: 1, processed_at: null }],
    });
    fixture.detectChanges();

    const drawer = fixture.nativeElement.querySelector('[data-testid="log-drawer"]') as HTMLElement;
    (drawer.querySelector('.btn-ghost.danger') as HTMLButtonElement | null)?.click();
    http
      .expectOne({ method: 'POST', url: '/api/workers/face-detect/retry-dead' })
      .flush({ ok: true, reset: 1 });
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('[data-testid="log-drawer"]')).toBeNull();
  });

  // ── RAW decode-pool control (ticket #673) ──────────────────────────────
  // The control now lives inside the expanded "preview" stage panel, so each
  // test must expand that row before the input is in the DOM.
  function expandPreviewRow(): void {
    const rows: NodeListOf<HTMLElement> = fixture.nativeElement.querySelectorAll(
      '[data-testid="worker-row"]',
    );
    const previewRow = Array.from(rows).find((r) => r.textContent?.includes('preview'))!;
    previewRow.querySelector<HTMLElement>('.row-summary')?.click();
    fixture.detectChanges();
  }

  it('renders the RAW decode workers control seeded from the performance config', () => {
    initWithMock();
    expandPreviewRow();
    const input = fixture.nativeElement.querySelector('#ffi-workers-input') as HTMLInputElement;
    expect(input).not.toBeNull();
    expect(input.value).toBe('1');
    // The min/max attributes reflect the server-supplied clamp bounds.
    expect(input.getAttribute('min')).toBe('1');
    expect(input.getAttribute('max')).toBe('16');
  });

  it('PATCHes the clamped worker count when Apply is clicked', () => {
    initWithMock();
    expandPreviewRow();
    const input = fixture.nativeElement.querySelector('#ffi-workers-input') as HTMLInputElement;
    input.value = '99';
    input.dispatchEvent(new Event('input'));
    fixture.detectChanges();

    const applyBtn = fixture.nativeElement.querySelector('.perf-save') as HTMLButtonElement;
    applyBtn.click();

    const req = http.expectOne('/api/workers/performance');
    expect(req.request.method).toBe('PATCH');
    // The component clamps to [min, max] before sending.
    expect(req.request.body).toEqual({ ffi_workers: 16 });
    req.flush({
      ok: true,
      ffi_workers: 16,
      source: 'db',
      pool: { target: 16, spawned: 0, busy: 0, queued: 0 },
    });
    fixture.detectChanges();

    // The control reflects the server's clamped value.
    expect(
      (fixture.nativeElement.querySelector('#ffi-workers-input') as HTMLInputElement).value,
    ).toBe('16');
  });

  it('hides the control when the performance route is unavailable', () => {
    // Flush status + enrichment + prune-window, but error the performance GET
    // (older server) — the control must stay hidden even with the preview row
    // expanded.
    fixture.detectChanges();
    http.expectOne('/api/workers/status').flush(MOCK_STATUS);
    http.expectOne('/api/enrichment/config').flush(MOCK_ENRICHMENT);
    http.expectOne('/api/workers/missing-reaper/prune-window').flush(MOCK_PRUNE);
    http
      .expectOne('/api/workers/performance')
      .flush({ error: 'not found' }, { status: 404, statusText: 'Not Found' });
    flushPanelPolls();
    fixture.detectChanges();
    expandPreviewRow();
    expect(fixture.nativeElement.querySelector('#ffi-workers-input')).toBeNull();
  });

  function expandFaceDetectRow(): HTMLElement {
    const rows: NodeListOf<HTMLElement> = fixture.nativeElement.querySelectorAll(
      '[data-testid="worker-row"]',
    );
    const faceRow = Array.from(rows).find((r) => r.textContent?.includes('face-detect'))!;
    faceRow.querySelector<HTMLElement>('.row-summary')?.click();
    fixture.detectChanges();
    return faceRow;
  }

  // Regression for the Copilot review note: clearing the Minimum face size
  // input must NOT persist 0 (which silently disables the filter, since 0 is a
  // valid "off" value). A blank field clears back to the default via null.
  it('saves face_min_detection_size as null (not 0) when the input is cleared', () => {
    initWithMock();
    const faceRow = expandFaceDetectRow();
    const input = faceRow.querySelector<HTMLInputElement>('[data-testid="face-min-size-input"]')!;
    expect(input).not.toBeNull();
    // Seeded from MOCK_ENRICHMENT (0.06); clear it.
    input.value = '';
    input.dispatchEvent(new Event('input'));
    fixture.detectChanges();

    faceRow.querySelector<HTMLButtonElement>('.btn-primary')?.click();

    // saveStage first PATCHes the stage runtime config, then PUTs enrichment.
    http.expectOne('/api/workers/face-detect/config').flush(null, { status: 204, statusText: '' });
    const put = http.expectOne('/api/enrichment/config');
    expect(put.request.method).toBe('PUT');
    // The load-bearing assertion: cleared input → null, never 0.
    expect(put.request.body.face_min_detection_size).toBeNull();
    put.flush(MOCK_ENRICHMENT);
    fixture.detectChanges();
  });

  it('saves face_min_detection_size as a number when a valid value is entered', () => {
    initWithMock();
    const faceRow = expandFaceDetectRow();
    const input = faceRow.querySelector<HTMLInputElement>('[data-testid="face-min-size-input"]')!;
    input.value = '0.1';
    input.dispatchEvent(new Event('input'));
    fixture.detectChanges();

    faceRow.querySelector<HTMLButtonElement>('.btn-primary')?.click();

    http.expectOne('/api/workers/face-detect/config').flush(null, { status: 204, statusText: '' });
    const put = http.expectOne('/api/enrichment/config');
    expect(put.request.body.face_min_detection_size).toBe(0.1);
    put.flush(MOCK_ENRICHMENT);
    fixture.detectChanges();
  });
});
