import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { FolderCrudService } from './folder-crud.service';
import { API_BASE_URL } from './api-base-url.token';

describe('FolderCrudService', () => {
  let svc: FolderCrudService;
  let http: HttpTestingController;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        FolderCrudService,
        { provide: API_BASE_URL, useValue: '/api' },
      ],
    });
    svc = TestBed.inject(FolderCrudService);
    http = TestBed.inject(HttpTestingController);
  });

  afterEach(() => http.verify());

  // #2949 — `/:id/move` (used for inline folder rename) 409s when the
  // target name already exists; this must resolve as a typed collision
  // outcome instead of an unhandled HTTP error the caller drops.
  describe('move', () => {
    it('resolves to an ok outcome carrying the response on success', () => {
      let outcome: unknown;
      svc.move('lib1', '2026', '2027').subscribe((o) => (outcome = o));
      const call = http.expectOne((r) => r.url === '/api/folders/lib1/move');
      expect(call.request.method).toBe('POST');
      expect(call.request.headers.get('X-Maple-Source-Path')).toBe('2026');
      expect(call.request.headers.get('X-Maple-Target-Path')).toBe('2027');
      call.flush({ abs_path: '/lib/2027' }, { status: 200, statusText: 'OK' });
      expect(outcome).toEqual({ kind: 'ok', result: { abs_path: '/lib/2027' } });
    });

    it('maps a 409 (target already exists) to a collision outcome, not an error', () => {
      let outcome: unknown;
      let errored = false;
      svc.move('lib1', '2026', '2027').subscribe({
        next: (o) => (outcome = o),
        error: () => (errored = true),
      });
      const call = http.expectOne((r) => r.url === '/api/folders/lib1/move');
      call.flush({ error: 'Target already exists' }, { status: 409, statusText: 'Conflict' });
      expect(errored).toBe(false);
      expect(outcome).toEqual({ kind: 'collision' });
    });

    it('propagates a non-409 error (e.g. 500) as a real error', () => {
      let errored = false;
      let outcome: unknown;
      svc.move('lib1', '2026', '2027').subscribe({
        next: (o) => (outcome = o),
        error: () => (errored = true),
      });
      const call = http.expectOne((r) => r.url === '/api/folders/lib1/move');
      call.flush({ error: 'move failed: boom' }, { status: 500, statusText: 'Server Error' });
      expect(errored).toBe(true);
      expect(outcome).toBeUndefined();
    });

    it('propagates a 404 (unknown folder) as a real error', () => {
      let errored = false;
      svc.move('lib1', '2026', '2027').subscribe({ error: () => (errored = true) });
      const call = http.expectOne((r) => r.url === '/api/folders/lib1/move');
      call.flush({ error: 'Folder not found' }, { status: 404, statusText: 'Not Found' });
      expect(errored).toBe(true);
    });
  });

  // mkdir is `mkdir -p`-idempotent server-side and never 409s (verified by
  // `folders.mkdir.test.ts`'s "is idempotent when the directory already
  // exists" case) — it stays a plain passthrough, no typed outcome.
  describe('mkdir', () => {
    it('resolves the raw response on success', () => {
      let result: unknown;
      svc.mkdir('lib1', '2026/March').subscribe((r) => (result = r));
      const call = http.expectOne((r) => r.url === '/api/folders/lib1/mkdir');
      expect(call.request.headers.get('X-Maple-Target-Path')).toBe('2026%2FMarch');
      call.flush({ abs_path: '/lib/2026/March' }, { status: 201, statusText: 'Created' });
      expect(result).toEqual({ abs_path: '/lib/2026/March' });
    });

    it('propagates a server error as a real error', () => {
      let errored = false;
      svc.mkdir('lib1', 'X').subscribe({ error: () => (errored = true) });
      const call = http.expectOne((r) => r.url === '/api/folders/lib1/mkdir');
      call.flush({ error: 'mkdir failed: boom' }, { status: 500, statusText: 'Server Error' });
      expect(errored).toBe(true);
    });
  });
});
