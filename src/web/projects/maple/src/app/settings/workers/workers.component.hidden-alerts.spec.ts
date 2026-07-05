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
  ApiHiddenPhoto,
  ApiEnrichmentStageState,
} from '@maple-common';

// Split out of workers.component.spec.ts (#file-budget) — covers the
// hidden-images "newly auto-hidden" alert banner in isolation. Setup mirrors
// the parent spec's WS/HTTP stubbing so the banner renders through the real
// component + template rather than the extracted service in isolation.
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
  face_detector_url: null,
  face_detector_sha256: null,
  face_recognizer_url: null,
  face_recognizer_sha256: null,
  face_min_detection_size: 0.06,
  meilisearch_url: null,
  meilisearch_api_key_set: false,
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
    face_detector_url: 'unset',
    face_detector_sha256: 'unset',
    face_recognizer_url: 'unset',
    face_recognizer_sha256: 'unset',
    face_min_detection_size: 'default',
    meilisearch_url: 'unset',
    meilisearch_api_key: 'unset',
  },
};

const MOCK_PERF = {
  ffi_workers: 1,
  source: 'default' as const,
  min: 1,
  max: 16,
  pool: { target: 1, spawned: 0, busy: 0, queued: 0 },
};

const MOCK_PRUNE = { hours: 24 };

const NO_STAGE: ApiEnrichmentStageState = {
  done_at: null,
  locked_by: null,
  lease_expires_at: null,
  attempts: 0,
  last_error: null,
  version: null,
  dead_letter_at: null,
};

const MOCK_HIDDEN_ALERT: ApiHiddenPhoto = {
  id: 'asset-1',
  address: 'lib:sub/img.dng',
  folder_id: 'folder-1',
  filename: 'img.dng',
  abs_path: '/lib/sub/img.dng',
  size: 1,
  mtime: 1,
  rating: 0,
  flag: 0,
  color_label: '',
  indexed_at: new Date().toISOString(),
  place: null,
  faces: [],
  description: null,
  description_meta: null,
  ocr_text: null,
  ocr_meta: null,
  vision: null,
  vision_meta: null,
  is_screenshot: null,
  hidden: true,
  hidden_reason: 'nudity',
  hidden_ack: false,
  enrichment: { geocode: NO_STAGE, face: NO_STAGE, describe: NO_STAGE },
};

describe('WorkersComponent — hidden-alerts banner', () => {
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
    for (const r of http.match('/api/folders')) r.flush([]);
    for (const r of http.match('/api/mirror/status')) r.flush({ queue: { pending: 0, dead: 0 } });
    for (const r of http.match((req) => req.url.includes('/api/photos/hidden'))) r.flush([]);
    http.verify();
  });

  /** Flush the one-shot GETs the side panels fire on init (migrations
   * registry, imports library labels + job list, backup/mirror library list +
   * queue status), so HttpTestingController.verify() is satisfied. */
  function flushPanelPolls(): void {
    http.expectOne('/api/workers/migration/migrations').flush({ migrations: [] });
    for (const r of http.match('/api/folders')) r.flush([]);
    for (const r of http.match('/api/mirror/status')) r.flush({ queue: { pending: 0, dead: 0 } });
    http.expectOne('/api/imports?limit=25').flush({ imports: [] });
  }

  /** Same init sequence as the parent spec's `initWithMock`, but lets the
   * caller control the `/api/photos/hidden` response instead of the afterEach
   * catch-all flushing it empty. */
  function initWithHiddenAlerts(alerts: unknown[]): void {
    fixture.detectChanges();
    wsFrames.next({ status: MOCK_STATUS, counted: true });
    http.expectOne('/api/workers/status').flush(MOCK_STATUS);
    http.expectOne('/api/enrichment/config').flush(MOCK_ENRICHMENT);
    http.expectOne('/api/workers/missing-reaper/prune-window').flush(MOCK_PRUNE);
    http.expectOne('/api/workers/performance').flush(MOCK_PERF);
    flushPanelPolls();
    http.expectOne((req) => req.url.includes('/api/photos/hidden')).flush(alerts);
    fixture.detectChanges();
  }

  it('renders the hidden-alerts banner when the API returns newly-hidden photos', () => {
    initWithHiddenAlerts([MOCK_HIDDEN_ALERT]);
    const banner = fixture.nativeElement.querySelector('.banner-alerts');
    expect(banner).toBeTruthy();
    expect(banner.textContent).toContain('img.dng');
  });

  it('does not render the hidden-alerts banner when there are none', () => {
    initWithHiddenAlerts([]);
    expect(fixture.nativeElement.querySelector('.banner-alerts')).toBeNull();
  });

  it('Acknowledge POSTs hidden-ack and dismisses the alert', () => {
    initWithHiddenAlerts([MOCK_HIDDEN_ALERT]);
    const buttons = Array.from(
      fixture.nativeElement.querySelectorAll('.banner-alerts button'),
    ) as HTMLButtonElement[];
    buttons.find((b) => b.textContent?.trim() === 'Acknowledge')!.click();

    http.expectOne('/api/assets/asset-1/hidden-ack').flush({ ok: true });
    fixture.detectChanges();

    expect(fixture.nativeElement.querySelector('.banner-alerts')).toBeNull();
  });

  it('Unhide POSTs xmp/batch with the address then hidden-ack, and dismisses the alert', () => {
    initWithHiddenAlerts([MOCK_HIDDEN_ALERT]);
    const buttons = Array.from(
      fixture.nativeElement.querySelectorAll('.banner-alerts button'),
    ) as HTMLButtonElement[];
    buttons.find((b) => b.textContent?.trim() === 'Unhide')!.click();

    const batch = http.expectOne('/api/xmp/batch');
    expect(batch.request.body.entries).toEqual([
      { address: 'lib:sub/img.dng', metadata: { hidden: false } },
    ]);
    batch.flush({ results: [{ address: 'lib:sub/img.dng', ok: true }] });

    http.expectOne('/api/assets/asset-1/hidden-ack').flush({ ok: true });
    fixture.detectChanges();

    expect(fixture.nativeElement.querySelector('.banner-alerts')).toBeNull();
  });
});
