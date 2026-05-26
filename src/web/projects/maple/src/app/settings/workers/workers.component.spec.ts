import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideHttpClientTesting, HttpTestingController } from '@angular/common/http/testing';
import { provideHttpClient } from '@angular/common/http';
import { provideRouter } from '@angular/router';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { WorkersComponent } from './workers.component';
import { API_BASE_URL } from '@maple-common';
import type { WorkersStatusResponse, EnrichmentConfigResponse } from '@maple-common';

const MOCK_CONFIG = {
  concurrency: 4,
  pollIntervalMs: 1000,
  batchSize: 10,
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
      dead: 0,
      throughput: 18,
      lastError: null,
      config: MOCK_CONFIG,
      batchSize: 10,
    },
    {
      name: 'face',
      status: 'running',
      inFlight: 1,
      configured: 2,
      pending: 842,
      dead: 3,
      throughput: 6,
      lastError: null,
      config: {
        concurrency: 2,
        pollIntervalMs: 1000,
        batchSize: 5,
        maxAttempts: 5,
        paused: false,
        last_seen_target_version: 1,
      },
      batchSize: 5,
    },
    {
      name: 'describe',
      status: 'error',
      inFlight: 0,
      configured: 2,
      pending: 842,
      dead: 0,
      throughput: 0,
      lastError: 'API key invalid',
      config: {
        concurrency: 2,
        pollIntervalMs: 1000,
        batchSize: 5,
        maxAttempts: 5,
        paused: false,
        last_seen_target_version: 1,
      },
      batchSize: 5,
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
  describe_model: 'qwen2.5vl:7b',
  describe_system_prompt: '',
  describe_daily_cap_usd: 0,
  face_worker_enabled: false,
  face_model_dir: '/tmp/.maple/models',
  face_retinaface_url: null,
  face_retinaface_sha256: null,
  face_mobilefacenet_url: null,
  face_mobilefacenet_sha256: null,
  meilisearch_url: null,
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
    face_worker_enabled: 'default',
    face_model_dir: 'default',
    face_retinaface_url: 'unset',
    face_retinaface_sha256: 'unset',
    face_mobilefacenet_url: 'unset',
    face_mobilefacenet_sha256: 'unset',
    meilisearch_url: 'unset',
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
      ],
    }).compileComponents();
    fixture = TestBed.createComponent(WorkersComponent);
    component = fixture.componentInstance;
    http = TestBed.inject(HttpTestingController);
  });

  afterEach(() => {
    component.ngOnDestroy();
    http.verify();
  });

  function initWithMock(): void {
    // ngOnInit fires both polls — flush both so HttpTestingController.verify()
    // doesn't complain at teardown.
    fixture.detectChanges();
    http.expectOne('/api/workers/status').flush(MOCK_STATUS);
    http.expectOne('/api/enrichment/config').flush(MOCK_ENRICHMENT);
    fixture.detectChanges();
  }

  it('fetches status on init and renders one row per stage', () => {
    initWithMock();
    const rows = fixture.nativeElement.querySelectorAll('[data-testid="worker-row"]');
    expect(rows.length).toBe(3);
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

  it('renders Pending count with thousands separator', () => {
    initWithMock();
    const rows: NodeListOf<HTMLElement> = fixture.nativeElement.querySelectorAll(
      '[data-testid="worker-row"]',
    );
    const hashRow = Array.from(rows).find((r) => r.textContent?.includes('hash'))!;
    expect(hashRow.querySelector('[data-testid="pending"]')?.textContent?.trim()).toBe('1,247');
  });

  it('renders Dead count with retry-affordance icon when dead > 0', () => {
    initWithMock();
    const rows: NodeListOf<HTMLElement> = fixture.nativeElement.querySelectorAll(
      '[data-testid="worker-row"]',
    );
    const faceRow = Array.from(rows).find((r) => r.textContent?.includes('face'))!;
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
    openLogsFor('face');

    const req = http.expectOne('/api/workers/face/dead?limit=50');
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
    openLogsFor('face');
    http.expectOne('/api/workers/face/dead?limit=50').flush({
      items: [{ id: 'a', abs_path: '/a.dng', last_error: 'x', attempts: 1, processed_at: null }],
    });
    fixture.detectChanges();

    const drawer = fixture.nativeElement.querySelector('[data-testid="log-drawer"]') as HTMLElement;
    (drawer.querySelector('.btn-ghost.danger') as HTMLButtonElement | null)?.click();
    http
      .expectOne({ method: 'POST', url: '/api/workers/face/retry-dead' })
      .flush({ ok: true, reset: 1 });
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('[data-testid="log-drawer"]')).toBeNull();
  });
});
