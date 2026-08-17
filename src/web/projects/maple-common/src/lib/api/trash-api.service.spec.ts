import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TrashApiService } from './trash-api.service';
import { API_BASE_URL } from './api-base-url.token';

describe('TrashApiService', () => {
  let svc: TrashApiService;
  let http: HttpTestingController;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        TrashApiService,
        { provide: API_BASE_URL, useValue: '/api' },
      ],
    });
    svc = TestBed.inject(TrashApiService);
    http = TestBed.inject(HttpTestingController);
  });

  afterEach(() => http.verify());

  describe('deleteAsset', () => {
    it('sends intent=trash on the query string and resolves ok on 204', () => {
      let outcome: unknown;
      svc.deleteAsset('asset-1', 'trash').subscribe((o) => (outcome = o));
      const call = http.expectOne((r) => r.url === '/api/assets/asset-1');
      expect(call.request.method).toBe('DELETE');
      expect(call.request.params.get('intent')).toBe('trash');
      call.flush(null, { status: 204, statusText: 'No Content' });
      expect(outcome).toEqual({ kind: 'ok' });
    });

    // #2841 — this is the direct regression test for the bug: the caller
    // (`TrashService`) is responsible for resolving a grid `slug:relPath`
    // address to a Mongo id BEFORE calling `deleteAsset`, but this method
    // still URL-encodes whatever id it's handed as defense in depth — a
    // real Mongo ObjectId hex string never needs escaping, but nothing here
    // should silently mis-route if some future caller ever passed a `/`
    // through unresolved.
    it('URL-encodes an id containing a slash into a single path segment', () => {
      svc.deleteAsset('507f1f77bcf86cd799439011', 'trash').subscribe();
      // A real Mongo id never needs escaping — asserted here as the normal
      // case this method is actually exercised with in production.
      const plain = http.expectOne((r) => r.url === '/api/assets/507f1f77bcf86cd799439011');
      expect(plain.request.method).toBe('DELETE');
      plain.flush(null, { status: 204, statusText: 'No Content' });

      // Simulates what would happen if a caller regressed and passed an
      // unresolved subfolder address straight through — this method must
      // still encode the `/` rather than let it fall through into the URL
      // path and 404 against a route that doesn't match.
      svc.deleteAsset('photos:2024/Trip/IMG_1.dng', 'trash').subscribe();
      const encoded = http.expectOne(
        (r) => r.url === '/api/assets/photos%3A2024%2FTrip%2FIMG_1.dng',
      );
      expect(encoded.request.method).toBe('DELETE');
      expect(encoded.request.params.get('intent')).toBe('trash');
      encoded.flush(null, { status: 204, statusText: 'No Content' });
    });

    it('sends intent=purge on the query string', () => {
      svc.deleteAsset('asset-1', 'purge').subscribe();
      const call = http.expectOne((r) => r.url === '/api/assets/asset-1');
      expect(call.request.params.get('intent')).toBe('purge');
      call.flush(null, { status: 204, statusText: 'No Content' });
    });

    // #2749 — a 409 state mismatch resolves to a typed conflict outcome
    // instead of throwing, so every caller handles it as a first-class
    // per-item result rather than a generic HTTP error.
    it('maps a 409 with state=trashed to a conflict outcome, not an error', () => {
      let outcome: unknown;
      let errored = false;
      svc.deleteAsset('asset-1', 'trash').subscribe({
        next: (o) => (outcome = o),
        error: () => (errored = true),
      });
      const call = http.expectOne((r) => r.url === '/api/assets/asset-1');
      call.flush(
        { error: 'Asset is already trashed', state: 'trashed' },
        { status: 409, statusText: 'Conflict' },
      );
      expect(errored).toBe(false);
      expect(outcome).toEqual({ kind: 'conflict', state: 'trashed' });
    });

    it('maps a 409 with state=live to a conflict outcome', () => {
      let outcome: unknown;
      svc.deleteAsset('asset-1', 'purge').subscribe((o) => (outcome = o));
      const call = http.expectOne((r) => r.url === '/api/assets/asset-1');
      call.flush(
        { error: 'Asset is not trashed', state: 'live' },
        { status: 409, statusText: 'Conflict' },
      );
      expect(outcome).toEqual({ kind: 'conflict', state: 'live' });
    });

    it('propagates a non-409 error (e.g. 500) as a real error', () => {
      let errored = false;
      let outcome: unknown;
      svc.deleteAsset('asset-1', 'trash').subscribe({
        next: (o) => (outcome = o),
        error: () => (errored = true),
      });
      const call = http.expectOne((r) => r.url === '/api/assets/asset-1');
      call.flush({ error: 'boom' }, { status: 500, statusText: 'Server Error' });
      expect(errored).toBe(true);
      expect(outcome).toBeUndefined();
    });

    it('propagates a 404 as a real error', () => {
      let errored = false;
      svc.deleteAsset('asset-1', 'purge').subscribe({ error: () => (errored = true) });
      const call = http.expectOne((r) => r.url === '/api/assets/asset-1');
      call.flush({ error: 'Asset not found' }, { status: 404, statusText: 'Not Found' });
      expect(errored).toBe(true);
    });
  });
});
