// PeopleStore — unit tests for the hide/unhide mutations.
//
// Split out from `people.store.spec.ts` to keep both files under the
// 600-LOC file-budget gate (mirrors the `clustering-job.merge-suggestions.
// test.ts` / `clustering-job.test.ts` split on the API side).
//
// Covers:
//   - hidePerson evicts the cached detail and invalidates both lists.
//   - hidePerson / hidePeople remove the affected rows from the cached list
//     SIGNAL immediately — before the mutation request(s) resolve — so a
//     hide reads as instant instead of waiting on the round-trip.
//   - hidePerson rolls back its optimistic removal via a list refetch when
//     the API call fails.
//   - hidePeople reconciles a partial batch failure via its trailing
//     (unconditional) refetch — an id whose hide failed server-side comes
//     back rather than staying stranded hidden client-side.
//   - unhidePerson invalidates both lists.
//
// The store fetches through BunApiBackendService (which already maps
// snake_case → camelCase), so we stub that service rather than the HTTP layer.

import { TestBed } from '@angular/core/testing';
import { of, throwError, Subject } from 'rxjs';
import { describe, it, expect, beforeEach, vi } from 'vitest';

import { PeopleStore } from './people.store';
import { BunApiBackendService, type ApiPerson } from './bun-api-backend.service';

function person(id: string, name: string, faceCount = 3): ApiPerson {
  return {
    id,
    name,
    faceCount,
    coverAssetId: null,
    coverAbsPath: null,
    coverBbox: null,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    hasMergeSuggestion: false,
  };
}

class ApiStub {
  listResult: ApiPerson[] = [person('p1', 'Alice'), person('p2', 'Person 7')];
  hiddenResult: ApiPerson[] = [person('h1', 'Hidden Hugo')];
  listPeople = vi.fn(() => of(this.listResult));
  listHiddenPeople = vi.fn(() => of(this.hiddenResult));
  getPerson = vi.fn((id: string, _page?: { offset: number; limit: number }) =>
    of({
      id,
      name: id === 'p1' ? 'Alice' : 'Person 7',
      coverAssetId: null,
      coverBbox: null,
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-01T00:00:00Z',
      faces: [],
      suggestedMerge: null,
    }),
  );
  hidePerson = vi.fn((_id: string) => of({ ok: true as const }));
  unhidePerson = vi.fn((_id: string) => of({ ok: true as const }));
  dismissMergeSuggestion = vi.fn((_id: string, _otherId: string) => of({ ok: true as const }));
}

function makeBed(api: ApiStub = new ApiStub()) {
  TestBed.configureTestingModule({
    providers: [{ provide: BunApiBackendService, useValue: api }],
  });
  return { api };
}

describe('PeopleStore — hide / unhide', () => {
  let store: PeopleStore;

  beforeEach(() => {
    TestBed.resetTestingModule();
  });

  it('hidePerson evicts the cached detail and invalidates both lists', async () => {
    const { api } = makeBed();
    store = TestBed.inject(PeopleStore);

    store.ensureList();
    store.ensureHidden();
    store.setActiveDetailId('p1');
    expect(store.detail()?.id).toBe('p1');

    await store.hidePerson('p1');

    expect(api.hidePerson).toHaveBeenCalledWith('p1');
    // Main list re-fetched (membership/counts changed).
    expect(api.listPeople).toHaveBeenCalledTimes(2);
    // Hidden list re-fetched (the person just joined it).
    expect(api.listHiddenPeople).toHaveBeenCalledTimes(2);
    // Cached detail evicted — `detail()` for the still-active id is gone.
    expect(store.detail()).toBeUndefined();
  });

  it('hidePerson removes the row from the cached list immediately — before the mutation request resolves', async () => {
    const api = new ApiStub();
    const hide$ = new Subject<{ ok: true }>();
    api.hidePerson = vi.fn(() => hide$.asObservable());
    makeBed(api);
    store = TestBed.inject(PeopleStore);
    store.ensureList();
    expect(store.data()?.map((p) => p.id)).toEqual(['p1', 'p2']);

    const hidePromise = store.hidePerson('p1');
    // Synchronous removal — the mutation request is still pending.
    expect(store.data()?.map((p) => p.id)).toEqual(['p2']);

    hide$.next({ ok: true });
    hide$.complete();
    await hidePromise;
  });

  it('hidePerson rolls back the optimistic removal via a list refetch when the API call fails', async () => {
    const api = new ApiStub();
    api.hidePerson = vi.fn(() => throwError(() => new Error('hide failed')));
    makeBed(api);
    store = TestBed.inject(PeopleStore);
    store.ensureList();
    expect(store.data()?.map((p) => p.id)).toEqual(['p1', 'p2']);

    await expect(store.hidePerson('p1')).rejects.toThrow('hide failed');

    // One extra fetch beyond the initial ensureList(): the failure-path
    // rollback. The row is back — the hide never happened server-side, so
    // the refetch's stub response still includes it.
    expect(api.listPeople).toHaveBeenCalledTimes(2);
    expect(store.data()?.map((p) => p.id)).toEqual(['p1', 'p2']);
  });

  it('hidePeople removes every selected row from the cached list immediately — before any mutation request resolves', async () => {
    const api = new ApiStub();
    api.listResult = [person('p1', 'Alice'), person('p2', 'Person 7'), person('p3', 'Cara')];
    const hide$ = new Subject<{ ok: true }>();
    api.hidePerson = vi.fn(() => hide$.asObservable());
    makeBed(api);
    store = TestBed.inject(PeopleStore);
    store.ensureList();
    expect(store.data()?.map((p) => p.id)).toEqual(['p1', 'p2', 'p3']);

    const hidePromise = store.hidePeople(['p1', 'p3']);
    // Both removed synchronously — neither mutation request has resolved yet.
    expect(store.data()?.map((p) => p.id)).toEqual(['p2']);

    hide$.next({ ok: true });
    hide$.complete();
    await hidePromise;
  });

  it('hidePeople reconciles a partial failure via the trailing refetch — the id that failed to hide comes back', async () => {
    const api = new ApiStub();
    api.listResult = [person('p1', 'Alice'), person('p2', 'Person 7')];
    api.hidePerson = vi.fn((id: string) =>
      id === 'p1' ? of({ ok: true as const }) : throwError(() => new Error('hide failed')),
    );
    makeBed(api);
    store = TestBed.inject(PeopleStore);
    store.ensureList();

    const result = await store.hidePeople(['p1', 'p2']);

    expect(result).toEqual({ ok: 1, failed: 1 });
    // p2's hide failed server-side. The trailing `_evictAndRefreshLists`
    // refetch (unconditional regardless of partial failure) reconciles the
    // optimistic removal against the stub's still-listing-p2 response — the
    // failed hide doesn't strand p2 hidden client-side while it's still live
    // on the server.
    expect(store.data()?.map((p) => p.id)).toContain('p2');
  });

  it('unhidePerson invalidates both lists', async () => {
    const { api } = makeBed();
    store = TestBed.inject(PeopleStore);

    store.ensureList();
    store.ensureHidden();
    await store.unhidePerson('h1');

    expect(api.unhidePerson).toHaveBeenCalledWith('h1');
    expect(api.listPeople).toHaveBeenCalledTimes(2);
    expect(api.listHiddenPeople).toHaveBeenCalledTimes(2);
  });
});
