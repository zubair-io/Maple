import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { ImportsApiService } from './imports-api.service';
import { API_BASE_URL } from './api-base-url.token';

describe('ImportsApiService', () => {
  let svc: ImportsApiService;
  let http: HttpTestingController;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        ImportsApiService,
        { provide: API_BASE_URL, useValue: '/api' },
      ],
    });
    svc = TestBed.inject(ImportsApiService);
    http = TestBed.inject(HttpTestingController);
  });

  afterEach(() => http.verify());

  it('cancel POSTs to /imports/:id/cancel', () => {
    let ok = false;
    svc.cancel('abc123').subscribe((r) => (ok = r.ok));
    const req = http.expectOne('/api/imports/abc123/cancel');
    expect(req.request.method).toBe('POST');
    req.flush({ ok: true });
    expect(ok).toBe(true);
  });

  it('retry POSTs to /imports/:id/retry (#795)', () => {
    let ok = false;
    svc.retry('abc123').subscribe((r) => (ok = r.ok));
    const req = http.expectOne('/api/imports/abc123/retry');
    expect(req.request.method).toBe('POST');
    expect(req.request.body).toEqual({});
    req.flush({ ok: true });
    expect(ok).toBe(true);
  });
});
