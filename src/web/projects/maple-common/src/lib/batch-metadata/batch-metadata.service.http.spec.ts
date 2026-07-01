// batch-metadata.service.http.spec.ts — HTTP wiring tests for BatchMetadataService (#1616).
// Verifies every service method hits the correct URL, HTTP method, request body, and
// response mapping.  Uses Angular TestBed + HttpTestingController.
//
// The service now sends { addresses } (slug:relPath strings) instead of { paths }.
//
// CI gate: bun x ng test Maple-common

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { BatchMetadataService } from './batch-metadata.service';
import type {
  AssetMetadataSnapshot,
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

  // ── fetchSnapshots ─────────────────────────────────────────────────────────

  describe('fetchSnapshots', () => {
    it('posts addresses to /api/metadata/snapshots and maps response', () => {
      const addresses = ['photos:a.dng', 'photos:b.dng'];
      let result: AssetMetadataSnapshot[] | undefined;
      svc.fetchSnapshots(addresses).subscribe((r) => (result = r));

      const req = http.expectOne('/api/metadata/snapshots');
      expect(req.request.method).toBe('POST');
      expect(req.request.body).toEqual({ addresses });

      req.flush({
        snapshots: [
          { address: 'photos:a.dng', metadata: { city: 'Paris', caption: 'Tower at dusk' } },
          { address: 'photos:b.dng', metadata: {} },
        ],
      });

      expect(result).toEqual([
        { address: 'photos:a.dng', metadata: { city: 'Paris', caption: 'Tower at dusk' } },
        { address: 'photos:b.dng', metadata: {} },
      ]);
    });
  });

  // ── batchApply ──────────────────────────────────────────────────────────────

  it('batchApply POSTs to /api/xmp/batch with { entries } body', () => {
    const entries: BatchApplyEntry[] = [
      { address: 'photos:a.jpg', metadata: { city: 'Paris' } },
      { address: 'photos:b.jpg', metadata: { city: 'Paris' } },
    ];
    let ok: boolean | undefined;
    svc.batchApply(entries).subscribe((r) => (ok = r.results.every((x) => x.ok)));

    const call = http.expectOne('/api/xmp/batch');
    expect(call.request.method).toBe('POST');
    expect(call.request.body).toEqual({ entries });

    call.flush({
      results: [
        { address: 'photos:a.jpg', ok: true },
        { address: 'photos:b.jpg', ok: true },
      ],
    });
    expect(ok).toBe(true);
  });

  it('batchApply propagates per-asset errors in the result', () => {
    const entries: BatchApplyEntry[] = [{ address: 'photos:c.jpg', metadata: {} }];
    let errorAddress: string | undefined;

    svc.batchApply(entries).subscribe((r) => {
      const failed = r.results.find((x) => !x.ok);
      errorAddress = failed?.address;
    });

    http.expectOne('/api/xmp/batch').flush({
      results: [{ address: 'photos:c.jpg', ok: false, error: 'permission denied' }],
    });
    expect(errorAddress).toBe('photos:c.jpg');
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

  // ── relocateCount ──────────────────────────────────────────────────────────

  it('relocateCount POSTs to /api/library/relocate-count with { addresses } body and returns count', () => {
    const addresses = ['photos:a.jpg', 'photos:b.jpg'];
    let result: RefileCountResult | undefined;
    svc.relocateCount(addresses).subscribe((r) => (result = r));

    const call = http.expectOne('/api/library/relocate-count');
    expect(call.request.method).toBe('POST');
    expect(call.request.body).toEqual({ addresses });
    call.flush({ count: 2 });
    expect(result).toEqual({ count: 2 });
  });

  it('relocateCount returns count of 0 when no assets qualify', () => {
    let count: number | undefined;
    svc.relocateCount(['photos:a.jpg']).subscribe((r) => (count = r.count));
    http.expectOne('/api/library/relocate-count').flush({ count: 0 });
    expect(count).toBe(0);
  });

  // ── relocate ───────────────────────────────────────────────────────────────

  it('relocate POSTs to /api/library/relocate with { addresses } body and returns full RefileResult', () => {
    const addresses = ['photos:a.jpg'];
    let result: RefileResult | undefined;
    svc.relocate(addresses).subscribe((r) => (result = r));

    const call = http.expectOne('/api/library/relocate');
    expect(call.request.method).toBe('POST');
    expect(call.request.body).toEqual({ addresses });
    call.flush({ results: [{ address: 'photos:a.jpg', ok: true, outcome: 'moved' }] });

    expect(result?.results).toHaveLength(1);
    expect(result?.results[0]!.address).toBe('photos:a.jpg');
    expect(result?.results[0]!.ok).toBe(true);
    expect(result?.results[0]!.outcome).toBe('moved');
  });

  it('relocate propagates per-asset errors in the RefileResult', () => {
    let result: RefileResult | undefined;
    svc.relocate(['photos:b.jpg']).subscribe((r) => (result = r));

    http.expectOne('/api/library/relocate').flush({
      results: [{ address: 'photos:b.jpg', ok: false, error: 'library root not found' }],
    });

    expect(result?.results[0]!.ok).toBe(false);
    expect(result?.results[0]!.error).toBe('library root not found');
  });
});
