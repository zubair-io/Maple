import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { TestBed } from '@angular/core/testing';
import {
  provideHttpClient,
} from '@angular/common/http';
import {
  HttpTestingController,
  provideHttpClientTesting,
} from '@angular/common/http/testing';
import { WorkersApiService, type WorkersStatusResponse, type WorkerConfig, type DeadListResponse } from './workers-api.service';
import { API_BASE_URL } from './api-base-url.token';

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
      config: { concurrency: 4, pollIntervalMs: 1000, batchSize: 10, maxAttempts: 5 },
      batchSize: 10,
    },
  ],
};

describe('WorkersApiService', () => {
  let svc: WorkersApiService;
  let http: HttpTestingController;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        WorkersApiService,
        { provide: API_BASE_URL, useValue: '/api' },
      ],
    });
    svc = TestBed.inject(WorkersApiService);
    http = TestBed.inject(HttpTestingController);
  });

  afterEach(() => http.verify());

  it('getStatus() GET /api/workers/status', () => {
    let result: WorkersStatusResponse | undefined;
    svc.getStatus().subscribe((r) => (result = r));
    http.expectOne('/api/workers/status').flush(MOCK_STATUS);
    expect(result).toEqual(MOCK_STATUS);
  });

  it('pause() POST /api/workers/hash/pause', () => {
    let called = false;
    svc.pause('hash').subscribe(() => (called = true));
    http.expectOne({ method: 'POST', url: '/api/workers/hash/pause' }).flush(null, { status: 204, statusText: 'No Content' });
    expect(called).toBe(true);
  });

  it('resume() POST /api/workers/hash/resume', () => {
    let called = false;
    svc.resume('hash').subscribe(() => (called = true));
    http.expectOne({ method: 'POST', url: '/api/workers/hash/resume' }).flush(null, { status: 204, statusText: 'No Content' });
    expect(called).toBe(true);
  });

  it('retryDead() POST /api/workers/face/retry-dead returns { ok, reset }', () => {
    let result: { ok: boolean; reset: number } | undefined;
    svc.retryDead('face').subscribe((r) => (result = r));
    http.expectOne({ method: 'POST', url: '/api/workers/face/retry-dead' }).flush({ ok: true, reset: 3 });
    expect(result?.ok).toBe(true);
    expect(result?.reset).toBe(3);
  });

  it('patchConfig() PATCH /api/workers/exif/config returns { ok, config }', () => {
    let result: { ok: boolean; config: WorkerConfig | null } | undefined;
    svc.patchConfig('exif', { concurrency: 8 }).subscribe((r) => (result = r));
    const req = http.expectOne('/api/workers/exif/config');
    expect(req.request.method).toBe('PATCH');
    expect(req.request.body).toEqual({ concurrency: 8 });
    req.flush({ ok: true, config: { concurrency: 8, pollIntervalMs: 1000, batchSize: 10, maxAttempts: 5 } });
    expect(result?.ok).toBe(true);
    expect(result?.config?.concurrency).toBe(8);
  });

  it('listDead() GET /api/workers/face/dead?limit=N returns the items array', () => {
    let result: DeadListResponse | undefined;
    svc.listDead('face', 25).subscribe((r) => (result = r));
    const req = http.expectOne('/api/workers/face/dead?limit=25');
    expect(req.request.method).toBe('GET');
    const payload: DeadListResponse = {
      items: [
        { id: 'abc', abs_path: '/photos/a.dng', last_error: 'OOM', attempts: 5, processed_at: '2026-05-11T12:00:00Z' },
      ],
    };
    req.flush(payload);
    expect(result).toEqual(payload);
  });
});
