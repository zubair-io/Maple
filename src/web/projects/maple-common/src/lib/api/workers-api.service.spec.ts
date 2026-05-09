import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { TestBed } from '@angular/core/testing';
import {
  provideHttpClient,
} from '@angular/common/http';
import {
  HttpTestingController,
  provideHttpClientTesting,
} from '@angular/common/http/testing';
import { WorkersApiService, type WorkersStatusResponse, type WorkerConfig } from './workers-api.service';
import { API_BASE_URL } from './api-base-url.token';

const MOCK_STATUS: WorkersStatusResponse = {
  stages: [
    {
      name: 'hash',
      status: 'running',
      workers: { active: 4, configured: 4 },
      in_flight: { dispatched: 3, batch_size: 10 },
      pending: 1247,
      dead: 0,
      throughput_per_minute: 18,
      last_error: null,
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

  it('retryDead() POST /api/workers/face/retry-dead', () => {
    let result: { reset: number } | undefined;
    svc.retryDead('face').subscribe((r: { reset: number }) => (result = r));
    http.expectOne({ method: 'POST', url: '/api/workers/face/retry-dead' }).flush({ reset: 3 });
    expect(result?.reset).toBe(3);
  });

  it('patchConfig() PATCH /api/workers/exif/config', () => {
    let result: { config: WorkerConfig } | undefined;
    svc.patchConfig('exif', { concurrency: 8 }).subscribe((r: { config: WorkerConfig }) => (result = r));
    const req = http.expectOne('/api/workers/exif/config');
    expect(req.request.method).toBe('PATCH');
    expect(req.request.body).toEqual({ concurrency: 8 });
    req.flush({ config: { concurrency: 8, pollIntervalMs: 1000, batchSize: 10, maxAttempts: 5 } });
    expect(result?.config.concurrency).toBe(8);
  });
});
