import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { BunApiBackendService, type DerivativeAuditStatusDto } from './bun-api-backend.service';
import { API_BASE_URL } from './api-base-url.token';

const STATUS: DerivativeAuditStatusDto = {
  config: {
    enabled: true,
    interval_ms: 21_600_000,
    max_resets_per_pass: 500,
    concurrency: 8,
    deep_r2_enabled: true,
  },
  progress: {
    scanned: 0,
    reArmed: 0,
    byStage: {},
    skippedCooldown: 0,
    errors: 0,
    startedAt: null,
    finishedAt: null,
    running: false,
  },
};

describe('BunApiBackendService derivative-audit', () => {
  let svc: BunApiBackendService;
  let http: HttpTestingController;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        BunApiBackendService,
        { provide: API_BASE_URL, useValue: '/api' },
      ],
    });
    svc = TestBed.inject(BunApiBackendService);
    http = TestBed.inject(HttpTestingController);
  });

  afterEach(() => http.verify());

  it('getDerivativeAuditStatus GETs the status endpoint', () => {
    let got: DerivativeAuditStatusDto | undefined;
    svc.getDerivativeAuditStatus().subscribe((r) => (got = r));
    const req = http.expectOne('/api/derivative-audit/status');
    expect(req.request.method).toBe('GET');
    req.flush(STATUS);
    expect(got?.config.enabled).toBe(true);
  });

  it('setDerivativeAuditConfig PUTs the partial patch', () => {
    let ok = false;
    svc.setDerivativeAuditConfig({ enabled: false }).subscribe((r) => (ok = r.ok));
    const req = http.expectOne('/api/derivative-audit/config');
    expect(req.request.method).toBe('PUT');
    expect(req.request.body).toEqual({ enabled: false });
    req.flush({ ok: true, config: { ...STATUS.config, enabled: false } });
    expect(ok).toBe(true);
  });

  it('runDerivativeAudit POSTs to /run', () => {
    let started = false;
    svc.runDerivativeAudit().subscribe((r) => (started = r.started));
    const req = http.expectOne('/api/derivative-audit/run');
    expect(req.request.method).toBe('POST');
    req.flush({ started: true });
    expect(started).toBe(true);
  });
});
