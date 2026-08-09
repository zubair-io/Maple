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
