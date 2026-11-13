import { TestBed } from '@angular/core/testing';
import { provideHttpClientTesting, HttpTestingController } from '@angular/common/http/testing';
import { provideHttpClient } from '@angular/common/http';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { API_BASE_URL, type PerformanceConfig } from '@maple-common';
import { DecodeWorkersPanelService } from './decode-workers-panel.service';

const GB = 1024 ** 3;

const PERF_WITH_BUDGET: PerformanceConfig = {
  ffi_workers: 16,
  source: 'db',
  min: 1,
  max: 16,
  pool: { target: 1, spawned: 0, busy: 0, queued: 0 },
  decode_memory_budget: {
    percent: 50,
    source: 'default',
    min: 0,
    max: 90,
    budget_bytes: 22 * GB,
    container_limit_bytes: 44 * GB,
    container_current_bytes: 30 * GB,
    container_source: 'cgroup-v2',
    live: { limit_bytes: 22 * GB, reserved_bytes: 8 * GB, running: 1, waiting: 2, at: 1 },
  },
};

describe('DecodeWorkersPanelService — decode memory budget (#5467)', () => {
  let service: DecodeWorkersPanelService;
  let http: HttpTestingController;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        { provide: API_BASE_URL, useValue: '/api' },
        DecodeWorkersPanelService,
      ],
    });
    service = TestBed.inject(DecodeWorkersPanelService);
    http = TestBed.inject(HttpTestingController);
  });

  afterEach(() => http.verify());

  it('seeds the budget draft and the live reservation readout from the server', () => {
    service.fetch();
    http.expectOne('/api/workers/performance').flush(PERF_WITH_BUDGET);
    expect(service.budgetDraft()).toBe('50');
    expect(service.budgetReadout()).toMatch(/^Reserved .+ of .+ · 1 running · 2 waiting$/);
  });

  it('sends the clamped budget percent alongside the worker count', () => {
    service.fetch();
    http.expectOne('/api/workers/performance').flush(PERF_WITH_BUDGET);
    service.setBudgetDraft('250');
    service.save();
    const req = http.expectOne('/api/workers/performance');
    expect(req.request.method).toBe('PATCH');
    expect(req.request.body).toEqual({ ffi_workers: 16, decode_memory_budget_percent: 90 });
    req.flush({
      ok: true,
      ...PERF_WITH_BUDGET,
      decode_memory_budget: { ...PERF_WITH_BUDGET.decode_memory_budget!, percent: 90 },
    });
    expect(service.budgetDraft()).toBe('90');
    expect(service.config()?.decode_memory_budget?.percent).toBe(90);
  });

  it('accepts 0 to remove the cap', () => {
    service.fetch();
    http.expectOne('/api/workers/performance').flush(PERF_WITH_BUDGET);
    service.setBudgetDraft('0');
    service.save();
    const req = http.expectOne('/api/workers/performance');
    expect(req.request.body).toEqual({ ffi_workers: 16, decode_memory_budget_percent: 0 });
    req.flush({ ok: true, ...PERF_WITH_BUDGET });
  });

  it('leaves an unchanged budget unsaved, so it keeps following the default', () => {
    service.fetch();
    http.expectOne('/api/workers/performance').flush(PERF_WITH_BUDGET);
    service.setDraft('8');
    service.save();
    const req = http.expectOne('/api/workers/performance');
    expect(req.request.body).toEqual({ ffi_workers: 8 });
    req.flush({ ok: true, ...PERF_WITH_BUDGET, ffi_workers: 8 });
  });

  it('sends only the worker count to a server without the budget', () => {
    const { decode_memory_budget: _omit, ...older } = PERF_WITH_BUDGET;
    service.fetch();
    http.expectOne('/api/workers/performance').flush(older);
    expect(service.budgetReadout()).toBeNull();
    service.save();
    const req = http.expectOne('/api/workers/performance');
    expect(req.request.body).toEqual({ ffi_workers: 16 });
    req.flush({ ok: true, ...older });
  });
});
