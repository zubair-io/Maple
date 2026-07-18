// PeopleStore — unit tests for the SWR list + detail cache.
//
// Covers:
//   - Store<T> signal-transition shape for the list: idle → loading → loaded
//     → refreshing.
//   - SWR semantics: first ensureList() fetches; a second call serves the
//     cached value immediately and kicks a background refresh (refreshing,
//     not loading — the prior value stays visible).
//   - invalidate() re-fetches the list while keeping the cached value shown.
//   - Detail cache keyed by id: setActiveDetailId fetches on first visit,
//     serves cached + refreshes on revisit; switching ids surfaces the right
//     cached entry.
//   - invalidateDetail(id) re-fetches a specific person.
//   - hidePerson evicts the detail and invalidates BOTH lists.
//   - unhidePerson invalidates both lists.
//   - Hidden-list SWR: ensureHidden / invalidateHidden mirror the main list.
//   - Errors surface on `error()` / `detailError()` without clobbering data.
//
// The store fetches through BunApiBackendService (which already maps
// snake_case → camelCase), so we stub that service rather than the HTTP layer.

import { TestBed } from '@angular/core/testing';
import { of, throwError, Subject } from 'rxjs';
import { describe, it, expect, beforeEach, vi } from 'vitest';

import { DETAIL_FACE_PAGE_SIZE, PeopleStore } from './people.store';
import {
  BunApiBackendService,
  type ApiPerson,
  type ApiPersonDetail,
} from './bun-api-backend.service';

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

function detail(id: string, name: string): ApiPersonDetail {
  return {
    id,
    name,
    coverAssetId: null,
    coverBbox: null,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    faces: [],
    suggestedMerge: null,
  };
}

/** A detail page with exactly `count` faces and the echoed `offset`/`limit`.
 * A full page (count === DETAIL_FACE_PAGE_SIZE) makes `detailHasMore` true so
 * `loadMoreFaces` will fire. */
function page(id: string, name: string, offset: number, count: number): ApiPersonDetail {
  return {
    ...detail(id, name),
    offset,
    limit: DETAIL_FACE_PAGE_SIZE,
    faces: Array.from({ length: count }, (_, i) => ({
      assetId: `${id}-asset-${offset + i}`,
      faceIndex: 0,
      absPath: `/lib/${id}/${offset + i}.jpg`,
      bbox: { x: 0, y: 0, w: 1, h: 1 },
      confidence: 0.9,
    })),
  };
}

class ApiStub {
  listResult: ApiPerson[] = [person('p1', 'Alice'), person('p2', 'Person 7')];
  hiddenResult: ApiPerson[] = [person('h1', 'Hidden Hugo')];
  listPeople = vi.fn(() => of(this.listResult));
  listHiddenPeople = vi.fn(() => of(this.hiddenResult));
  // The store calls getPerson(id, { offset, limit }); the stub accepts (and
  // ignores) the page opts so call-shape assertions and the runtime path match.
  getPerson = vi.fn((id: string, _page?: { offset: number; limit: number }) =>
    of(detail(id, id === 'p1' ? 'Alice' : 'Person 7')),
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

describe('PeopleStore', () => {
  let store: PeopleStore;

  beforeEach(() => {
    TestBed.resetTestingModule();
  });

  it('starts idle with no list data', () => {
    makeBed();
    store = TestBed.inject(PeopleStore);

    expect(store.status()).toBe('idle');
    expect(store.data()).toBeUndefined();
    expect(store.loading()).toBe(false);
    expect(store.refreshing()).toBe(false);
    expect(store.error()).toBeNull();
  });

  it('ensureList(): first call fetches (loading → loaded)', () => {
    const { api } = makeBed();
    store = TestBed.inject(PeopleStore);

    store.ensureList();

    expect(api.listPeople).toHaveBeenCalledTimes(1);
    expect(store.status()).toBe('loaded');
    expect(store.data()).toHaveLength(2);
    expect(store.data()![0].name).toBe('Alice');
  });

  it('ensureList(): exposes `loading` while the first fetch is in flight', () => {
    const subject = new Subject<ApiPerson[]>();
    const api = new ApiStub();
    api.listPeople = vi.fn(() => subject.asObservable());
    makeBed(api);
    store = TestBed.inject(PeopleStore);

    store.ensureList();
    expect(store.loading()).toBe(true);
    expect(store.status()).toBe('loading');
    expect(store.data()).toBeUndefined();

    subject.next([person('p1', 'Alice')]);
    subject.complete();
    expect(store.loading()).toBe(false);
    expect(store.status()).toBe('loaded');
  });

  it('SWR: second ensureList() serves cached value and refreshes in background', () => {
    const subjects: Subject<ApiPerson[]>[] = [];
    const api = new ApiStub();
    api.listPeople = vi.fn(() => {
      const s = new Subject<ApiPerson[]>();
      subjects.push(s);
      return s.asObservable();
    });
    makeBed(api);
    store = TestBed.inject(PeopleStore);

    // First fetch resolves.
    store.ensureList();
    subjects[0].next([person('p1', 'Alice')]);
    subjects[0].complete();
    expect(store.data()).toHaveLength(1);

    // Second call: cached value stays visible, status is `refreshing`.
    store.ensureList();
    expect(api.listPeople).toHaveBeenCalledTimes(2);
    expect(store.refreshing()).toBe(true);
    expect(store.loading()).toBe(false);
    expect(store.status()).toBe('refreshing');
    expect(store.data()).toHaveLength(1); // prior value still shown

    // Refresh lands with new data.
    subjects[1].next([person('p1', 'Alice'), person('p2', 'Bob')]);
    subjects[1].complete();
    expect(store.status()).toBe('loaded');
    expect(store.data()).toHaveLength(2);
  });

  it('dedupes overlapping list fetches via the in-flight guard', () => {
    const subject = new Subject<ApiPerson[]>();
    const api = new ApiStub();
    api.listPeople = vi.fn(() => subject.asObservable());
    makeBed(api);
    store = TestBed.inject(PeopleStore);

    store.ensureList();
    store.ensureList(); // in flight — must not fire a second request
    expect(api.listPeople).toHaveBeenCalledTimes(1);

    subject.next([]);
    subject.complete();
  });

  it('invalidate() while in-flight sets dirty flag and re-fires once the fetch lands', () => {
    // Regression for #1310: without the _listDirty flag, an invalidate() that
    // arrives while a list fetch is in flight is silently dropped — the UI is
    // left showing stale data after the mutation that triggered the invalidate.
    const subjects: Subject<ApiPerson[]>[] = [];
    const api = new ApiStub();
    api.listPeople = vi.fn(() => {
      const s = new Subject<ApiPerson[]>();
      subjects.push(s);
      return s.asObservable();
    });
    makeBed(api);
    store = TestBed.inject(PeopleStore);

    // Start a fetch — now in flight.
    store.ensureList();
    expect(api.listPeople).toHaveBeenCalledTimes(1);

    // Invalidate while in flight — must NOT fire a second fetch immediately.
    store.invalidate();
    expect(api.listPeople).toHaveBeenCalledTimes(1);

    // First fetch lands — the dirty flag must trigger a second fetch.
    subjects[0].next([person('p1', 'Alice')]);
    subjects[0].complete();
    expect(api.listPeople).toHaveBeenCalledTimes(2);

    // The second fetch must NOT loop — completing it without another invalidate
    // must leave the call count at exactly 2.
    subjects[1].next([person('p1', 'Alice (fresh)'), person('p2', 'Bob')]);
    subjects[1].complete();
    expect(api.listPeople).toHaveBeenCalledTimes(2);
    expect(store.data()![0].name).toBe('Alice (fresh)');
  });

  it('invalidate() re-fetches the list, keeping the cached value visible', () => {
    const subjects: Subject<ApiPerson[]>[] = [];
    const api = new ApiStub();
    api.listPeople = vi.fn(() => {
      const s = new Subject<ApiPerson[]>();
      subjects.push(s);
      return s.asObservable();
    });
    makeBed(api);
    store = TestBed.inject(PeopleStore);

    store.ensureList();
    subjects[0].next([person('p1', 'Alice')]);
    subjects[0].complete();

    store.invalidate();
    expect(store.refreshing()).toBe(true);
    expect(store.data()).toHaveLength(1);

    subjects[1].next([person('p1', 'Alice (renamed)')]);
    subjects[1].complete();
    expect(store.data()![0].name).toBe('Alice (renamed)');
  });

  it('surfaces a list fetch error on error() without throwing', () => {
    const api = new ApiStub();
    api.listPeople = vi.fn(() => throwError(() => new Error('network down')));
    makeBed(api);
    store = TestBed.inject(PeopleStore);

    store.ensureList();
    expect(store.status()).toBe('error');
    expect(store.error()?.message).toBe('network down');
    expect(store.data()).toBeUndefined();
  });

  // ── Detail cache ──────────────────────────────────────────────────────────

  it('setActiveDetailId(): first visit fetches the detail', () => {
    const { api } = makeBed();
    store = TestBed.inject(PeopleStore);

    store.setActiveDetailId('p1');
    // The detail fetch always requests the first face page.
    expect(api.getPerson).toHaveBeenCalledWith('p1', { offset: 0, limit: DETAIL_FACE_PAGE_SIZE });
    expect(store.detail()?.id).toBe('p1');
    expect(store.detailLoading()).toBe(false);
  });

  it('detail SWR: revisiting a cached id serves it instantly and refreshes', () => {
    const subjects: Record<string, Subject<ApiPersonDetail>[]> = {};
    const api = new ApiStub();
    api.getPerson = vi.fn((id: string, _page?: { offset: number; limit: number }) => {
      const s = new Subject<ApiPersonDetail>();
      (subjects[id] ??= []).push(s);
      return s.asObservable();
    });
    makeBed(api);
    store = TestBed.inject(PeopleStore);

    store.setActiveDetailId('p1');
    subjects['p1'][0].next(detail('p1', 'Alice'));
    subjects['p1'][0].complete();
    expect(store.detail()?.name).toBe('Alice');

    // Navigate away, then back to p1 — cached value renders immediately while
    // a background refresh runs.
    store.setActiveDetailId(null);
    store.setActiveDetailId('p1');
    expect(store.detail()?.name).toBe('Alice'); // cached, instant
    expect(store.detailRefreshing()).toBe(true);
    expect(store.detailLoading()).toBe(false);

    subjects['p1'][1].next(detail('p1', 'Alice 2'));
    subjects['p1'][1].complete();
    expect(store.detail()?.name).toBe('Alice 2');
  });

  it('detail cache is keyed by id — switching active id surfaces the right entry', () => {
    const { api } = makeBed();
    store = TestBed.inject(PeopleStore);

    store.setActiveDetailId('p1');
    expect(store.detail()?.id).toBe('p1');

    store.setActiveDetailId('p2');
    expect(store.detail()?.id).toBe('p2');
    expect(api.getPerson).toHaveBeenCalledTimes(2);
  });

  it('setActiveDetailId(null) clears the active detail', () => {
    makeBed();
    store = TestBed.inject(PeopleStore);

    store.setActiveDetailId('p1');
    expect(store.detail()).toBeDefined();
    store.setActiveDetailId(null);
    expect(store.detail()).toBeUndefined();
    expect(store.detailLoading()).toBe(false);
  });

  it('invalidateDetail(id) re-fetches a specific person', () => {
    const subjects: Subject<ApiPersonDetail>[] = [];
    const api = new ApiStub();
    api.getPerson = vi.fn((_id: string, _page?: { offset: number; limit: number }) => {
      const s = new Subject<ApiPersonDetail>();
      subjects.push(s);
      return s.asObservable();
    });
    makeBed(api);
    store = TestBed.inject(PeopleStore);

    store.setActiveDetailId('p1');
    subjects[0].next(detail('p1', 'Alice'));
    subjects[0].complete();

    store.invalidateDetail('p1');
    expect(store.detailRefreshing()).toBe(true);
    subjects[1].next(detail('p1', 'Renamed'));
    subjects[1].complete();
    expect(store.detail()?.name).toBe('Renamed');
  });

  it('invalidateDetail during an in-flight loadMore re-fetches page 0 once', () => {
    // Regression: the per-id in-flight guard made invalidateDetail() early-return
    // (dropping the invalidation) when a loadMoreFaces page>0 fetch was in
    // flight, leaving stale detail. The dirty flag must re-fetch page 0 on the
    // in-flight fetch's completion.
    const calls: { offset: number; subject: Subject<ApiPersonDetail> }[] = [];
    const api = new ApiStub();
    api.getPerson = vi.fn((_id: string, opts?: { offset: number; limit: number }) => {
      const s = new Subject<ApiPersonDetail>();
      calls.push({ offset: opts?.offset ?? 0, subject: s });
      return s.asObservable();
    });
    makeBed(api);
    store = TestBed.inject(PeopleStore);

    // First page lands full → detailHasMore is true.
    store.setActiveDetailId('p1');
    expect(calls[0].offset).toBe(0);
    calls[0].subject.next(page('p1', 'Alice', 0, DETAIL_FACE_PAGE_SIZE));
    calls[0].subject.complete();
    expect(store.detailHasMore()).toBe(true);
    expect(store.detail()?.faces.length).toBe(DETAIL_FACE_PAGE_SIZE);

    // Start loading the next page — now in flight at offset = pageSize.
    store.loadMoreFaces('p1');
    expect(calls).toHaveLength(2);
    expect(calls[1].offset).toBe(DETAIL_FACE_PAGE_SIZE);

    // Invalidate WHILE the loadMore is in flight. Must NOT fire a third fetch
    // immediately (guarded); it's deferred via the dirty flag.
    store.invalidateDetail('p1');
    expect(calls).toHaveLength(2);

    // The in-flight loadMore lands (accumulates a second page)…
    calls[1].subject.next(page('p1', 'Alice', DETAIL_FACE_PAGE_SIZE, DETAIL_FACE_PAGE_SIZE));
    calls[1].subject.complete();

    // …and the deferred invalidation now fires a fresh page-0 re-fetch.
    expect(calls).toHaveLength(3);
    expect(calls[2].offset).toBe(0);

    // That page-0 response REPLACES the accumulated faces (no stale carryover).
    calls[2].subject.next(page('p1', 'Alice (fresh)', 0, 2));
    calls[2].subject.complete();
    expect(store.detail()?.name).toBe('Alice (fresh)');
    expect(store.detail()?.faces.length).toBe(2);

    // Exactly one deferred re-fetch — completing it must not loop.
    expect(calls).toHaveLength(3);
  });

  it('clears a stale detailError once a later detail fetch succeeds', () => {
    // Regression: previously `_detailError` was only reset in
    // setActiveDetailId(), so an `invalidateDetail()` re-fetch (or SWR
    // refresh) that succeeded left the old error on screen over fresh data.
    const subjects: Subject<ApiPersonDetail>[] = [];
    const api = new ApiStub();
    api.getPerson = vi.fn((_id: string, _page?: { offset: number; limit: number }) => {
      const s = new Subject<ApiPersonDetail>();
      subjects.push(s);
      return s.asObservable();
    });
    makeBed(api);
    store = TestBed.inject(PeopleStore);

    // First detail fetch fails — error surfaces.
    store.setActiveDetailId('p1');
    subjects[0].error(new Error('detail boom'));
    expect(store.detailError()?.message).toBe('detail boom');

    // A later re-fetch of the same id must clear the stale error on START…
    store.invalidateDetail('p1');
    expect(store.detailError()).toBeNull();

    // …and stay null once it lands successfully.
    subjects[1].next(detail('p1', 'Alice'));
    subjects[1].complete();
    expect(store.detailError()).toBeNull();
    expect(store.detail()?.name).toBe('Alice');
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

  it('hidePerson rejects (and does not invalidate) when the API call fails', async () => {
    const api = new ApiStub();
    api.hidePerson = vi.fn(() => throwError(() => new Error('hide failed')));
    makeBed(api);
    store = TestBed.inject(PeopleStore);
    store.ensureList();

    await expect(store.hidePerson('p1')).rejects.toThrow('hide failed');
    // No extra list fetch beyond the initial ensureList().
    expect(api.listPeople).toHaveBeenCalledTimes(1);
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

  // ── Hidden-list SWR ─────────────────────────────────────────────────────────

  it('ensureHidden(): first call fetches (loading → loaded)', () => {
    const { api } = makeBed();
    store = TestBed.inject(PeopleStore);

    expect(store.hiddenStatus()).toBe('idle');
    store.ensureHidden();
    expect(api.listHiddenPeople).toHaveBeenCalledTimes(1);
    expect(store.hiddenStatus()).toBe('loaded');
    expect(store.hidden()).toHaveLength(1);
    expect(store.hidden()![0].name).toBe('Hidden Hugo');
  });

  it('hidden SWR: second ensureHidden() serves cached value and refreshes', () => {
    const subjects: Subject<ApiPerson[]>[] = [];
    const api = new ApiStub();
    api.listHiddenPeople = vi.fn(() => {
      const s = new Subject<ApiPerson[]>();
      subjects.push(s);
      return s.asObservable();
    });
    makeBed(api);
    store = TestBed.inject(PeopleStore);

    store.ensureHidden();
    subjects[0].next([person('h1', 'Hidden Hugo')]);
    subjects[0].complete();
    expect(store.hidden()).toHaveLength(1);

    store.ensureHidden();
    expect(api.listHiddenPeople).toHaveBeenCalledTimes(2);
    expect(store.hiddenRefreshing()).toBe(true);
    expect(store.hiddenLoading()).toBe(false);
    expect(store.hidden()).toHaveLength(1); // prior value still shown

    subjects[1].next([]);
    subjects[1].complete();
    expect(store.hiddenStatus()).toBe('loaded');
    expect(store.hidden()).toHaveLength(0);
  });

  it('surfaces a hidden-list fetch error on hiddenError() without throwing', () => {
    const api = new ApiStub();
    api.listHiddenPeople = vi.fn(() => throwError(() => new Error('hidden boom')));
    makeBed(api);
    store = TestBed.inject(PeopleStore);

    store.ensureHidden();
    expect(store.hiddenStatus()).toBe('error');
    expect(store.hiddenError()?.message).toBe('hidden boom');
    expect(store.hidden()).toBeUndefined();
  });

  // ── dismissMergeSuggestion ────────────────────────────────────────────────

  describe('dismissMergeSuggestion', () => {
    it('calls the API, evicts the other person, and refreshes this detail + the list', async () => {
      const { api } = makeBed();
      store = TestBed.inject(PeopleStore);
      store.ensureList();

      await store.dismissMergeSuggestion('p1', 'p2');

      expect(api.dismissMergeSuggestion).toHaveBeenCalledWith('p1', 'p2');
      expect(api.getPerson).toHaveBeenCalledWith('p1', { offset: 0, limit: DETAIL_FACE_PAGE_SIZE });
      expect(api.listPeople).toHaveBeenCalledTimes(2); // initial ensureList() + invalidate()
    });

    it('propagates a failure, refetching this detail so a stale banner converges', async () => {
      const api = new ApiStub();
      api.dismissMergeSuggestion = vi.fn(() => throwError(() => new Error('boom')));
      makeBed(api);
      store = TestBed.inject(PeopleStore);
      store.ensureList();

      await expect(store.dismissMergeSuggestion('p1', 'p2')).rejects.toThrow('boom');

      // A 404 here means the suggestion is already stale server-side — the
      // person's own detail refetches so the banner converges, but neither
      // the other person's cache nor the list is touched.
      expect(api.getPerson).toHaveBeenCalledWith('p1', { offset: 0, limit: DETAIL_FACE_PAGE_SIZE });
      expect(api.listPeople).toHaveBeenCalledTimes(1); // ensureList() only — no invalidate()
    });
  });
});
