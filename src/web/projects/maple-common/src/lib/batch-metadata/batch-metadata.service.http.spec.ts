// batch-metadata.service.http.spec.ts — HTTP wiring tests for BatchMetadataService (#1616).
// Verifies every service method hits the correct URL, HTTP method, request body, and
// response mapping.  Uses Angular TestBed + HttpTestingController.
//
// CI gate: bun x ng test Maple-common

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { BatchMetadataService } from './batch-metadata.service';
import type {
  BatchApplyEntry,
  RefileCountResult,
  RefileResult,
  GeocodeCandidate,
} from './batch-metadata.types';

describe('BatchMetadataService HTTP wiring', () => {
  let svc: BatchMetadataService;
  let http: HttpTestingController;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [provideHttpClient(), provideHttpClientTesting(), BatchMetadataService],
    });
    svc = TestBed.inject(BatchMetadataService);
    http = TestBed.inject(HttpTestingController);
  });

  afterEach(() => http.verify());

  // ── batchApply ──────────────────────────────────────────────────────────────

  it('batchApply POSTs to /api/xmp/batch with { entries } body', () => {
    const entries: BatchApplyEntry[] = [
      { path: '/photos/a.jpg', metadata: { city: 'Paris' } },
      { path: '/photos/b.jpg', metadata: { city: 'Paris' } },
    ];
    let ok: boolean | undefined;
    svc.batchApply(entries).subscribe((r) => (ok = r.results.every((x) => x.ok)));

    const call = http.expectOne('/api/xmp/batch');
    expect(call.request.method).toBe('POST');
    expect(call.request.body).toEqual({ entries });

    call.flush({
      results: [
        { path: '/photos/a.jpg', ok: true },
        { path: '/photos/b.jpg', ok: true },
      ],
    });
    expect(ok).toBe(true);
  });

  it('batchApply propagates per-asset errors in the result', () => {
    const entries: BatchApplyEntry[] = [{ path: '/photos/c.jpg', metadata: {} }];
    let errorPath: string | undefined;

    svc.batchApply(entries).subscribe((r) => {
      const failed = r.results.find((x) => !x.ok);
      errorPath = failed?.path;
    });

    http.expectOne('/api/xmp/batch').flush({
      results: [{ path: '/photos/c.jpg', ok: false, error: 'permission denied' }],
    });
    expect(errorPath).toBe('/photos/c.jpg');
  });

  // ── geocodeSearch ──────────────────────────────────────────────────────────

  it('geocodeSearch GETs /api/geocode/search?q= and extracts suggestions from the envelope', () => {
    const candidates: GeocodeCandidate[] = [
      {
        displayName: 'Paris, France',
        lat: 48.8566,
        lon: 2.3522,
        address: { city: 'Paris', country: 'France', country_code: 'fr' },
      },
    ];
    let result: GeocodeCandidate[] | undefined;
    svc.geocodeSearch('Paris').subscribe((r) => (result = r));

    const call = http.expectOne(
      (req) => req.url === '/api/geocode/search' && req.params.get('q') === 'Paris',
    );
    expect(call.request.method).toBe('GET');
    call.flush({ suggestions: candidates });

    expect(result).toHaveLength(1);
    expect(result![0]!.displayName).toBe('Paris, France');
    expect(result![0]!.lat).toBe(48.8566);
  });

  it('geocodeSearch returns an empty array when suggestions is empty', () => {
    let result: GeocodeCandidate[] | undefined;
    svc.geocodeSearch('xyzzy').subscribe((r) => (result = r));

    http.expectOne((req) => req.url === '/api/geocode/search').flush({ suggestions: [] });
    expect(result).toEqual([]);
  });

  // ── refileCount ────────────────────────────────────────────────────────────

  it('refileCount POSTs to /api/backup/refile-count with { paths } body and returns count', () => {
    const paths = ['/photos/a.jpg', '/photos/b.jpg'];
    let result: RefileCountResult | undefined;
    svc.refileCount(paths).subscribe((r) => (result = r));

    const call = http.expectOne('/api/backup/refile-count');
    expect(call.request.method).toBe('POST');
    expect(call.request.body).toEqual({ paths });
    call.flush({ count: 2 });
    expect(result).toEqual({ count: 2 });
  });

  it('refileCount returns count of 0 when no assets qualify', () => {
    let count: number | undefined;
    svc.refileCount(['/photos/a.jpg']).subscribe((r) => (count = r.count));
    http.expectOne('/api/backup/refile-count').flush({ count: 0 });
    expect(count).toBe(0);
  });

  // ── refile ─────────────────────────────────────────────────────────────────

  it('refile POSTs to /api/backup/refile with { paths } body and returns full RefileResult', () => {
    const paths = ['/photos/a.jpg'];
    let result: RefileResult | undefined;
    svc.refile(paths).subscribe((r) => (result = r));

    const call = http.expectOne('/api/backup/refile');
    expect(call.request.method).toBe('POST');
    expect(call.request.body).toEqual({ paths });
    call.flush({ results: [{ path: '/photos/a.jpg', ok: true, outcome: 'moved' }] });

    expect(result?.results).toHaveLength(1);
    expect(result?.results[0]!.path).toBe('/photos/a.jpg');
    expect(result?.results[0]!.ok).toBe(true);
    expect(result?.results[0]!.outcome).toBe('moved');
  });

  it('refile propagates per-asset errors in the RefileResult', () => {
    let result: RefileResult | undefined;
    svc.refile(['/photos/b.jpg']).subscribe((r) => (result = r));

    http
      .expectOne('/api/backup/refile')
      .flush({ results: [{ path: '/photos/b.jpg', ok: false, error: 'permission denied' }] });

    expect(result?.results[0]!.ok).toBe(false);
    expect(result?.results[0]!.error).toBe('permission denied');
  });
});
