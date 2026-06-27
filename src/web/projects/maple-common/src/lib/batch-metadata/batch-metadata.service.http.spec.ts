// batch-metadata.service.http.spec.ts — HTTP wiring tests for BatchMetadataService (#1630).
// Verifies refileCount() and refile() hit the correct URLs, HTTP method, and body.
// Uses Angular TestBed + HttpTestingController (same pattern as pano.service.spec.ts).
//
// These tests require the Angular test environment initialised by `ng test`.
// They are skipped when run under bare `bun x vitest run` (no initTestEnvironment).
// CI gate: bun x ng test Maple-common

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { BatchMetadataService } from './batch-metadata.service';
import type { RefileCountResult, RefileResult } from './batch-metadata.types';

// Angular's TestBed requires initTestEnvironment() which is called automatically
// by `ng test` but not by bare vitest. Skip this suite when the environment is absent.
const hasAngularTestEnv = (() => {
  try {
    TestBed.configureTestingModule({});
    TestBed.resetTestingModule();
    return true;
  } catch {
    return false;
  }
})();

describe.skipIf(!hasAngularTestEnv)('BatchMetadataService HTTP wiring', () => {
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
