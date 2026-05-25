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
//   - deletePerson evicts the detail and invalidates the list.
//   - Errors surface on `error()` / `detailError()` without clobbering data.
//
// The store fetches through BunApiBackendService (which already maps
// snake_case → camelCase), so we stub that service rather than the HTTP layer.

import { TestBed } from '@angular/core/testing';
import { of, throwError, Subject } from 'rxjs';
import { describe, it, expect, beforeEach, vi } from 'vitest';

import { PeopleStore } from './people.store';
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
  };
}

class ApiStub {
  listResult: ApiPerson[] = [person('p1', 'Alice'), person('p2', 'Person 7')];
  listPeople = vi.fn(() => of(this.listResult));
  getPerson = vi.fn((id: string) => of(detail(id, id === 'p1' ? 'Alice' : 'Person 7')));
  deletePerson = vi.fn((_id: string) => of(undefined as void));
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
    expect(api.getPerson).toHaveBeenCalledWith('p1');
    expect(store.detail()?.id).toBe('p1');
    expect(store.detailLoading()).toBe(false);
  });

  it('detail SWR: revisiting a cached id serves it instantly and refreshes', () => {
    const subjects: Record<string, Subject<ApiPersonDetail>[]> = {};
    const api = new ApiStub();
    api.getPerson = vi.fn((id: string) => {
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
    api.getPerson = vi.fn(() => {
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

  it('deletePerson evicts the cached detail and invalidates the list', async () => {
    const { api } = makeBed();
    store = TestBed.inject(PeopleStore);

    store.ensureList();
    store.setActiveDetailId('p1');
    expect(store.detail()?.id).toBe('p1');

    await store.deletePerson('p1');

    expect(api.deletePerson).toHaveBeenCalledWith('p1');
    // List re-fetched (membership/counts changed).
    expect(api.listPeople).toHaveBeenCalledTimes(2);
    // Cached detail evicted — `detail()` for the still-active id is gone.
    expect(store.detail()).toBeUndefined();
  });

  it('deletePerson rejects (and does not invalidate) when the API delete fails', async () => {
    const api = new ApiStub();
    api.deletePerson = vi.fn(() => throwError(() => new Error('delete failed')));
    makeBed(api);
    store = TestBed.inject(PeopleStore);
    store.ensureList();

    await expect(store.deletePerson('p1')).rejects.toThrow('delete failed');
    // No extra list fetch beyond the initial ensureList().
    expect(api.listPeople).toHaveBeenCalledTimes(1);
  });
});
