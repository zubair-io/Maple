// SearchComponent — unit tests for responsive-program S7 (#622).
//
// Spec: docs/design/responsive-program/s7-search.md §5.
//
// We use vitest's fake timers (vi.useFakeTimers / advanceTimersByTime) to
// pump the 250ms debounce — Angular's `fakeAsync` requires zone-testing,
// which the @angular/build:unit-test runner does NOT bundle. Pattern
// matches `library-state.service.spec.ts` already in the repo.

import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { provideHttpClientTesting, HttpTestingController } from '@angular/common/http/testing';
import { Observable, Subject, of } from 'rxjs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SearchComponent, scopeToParams } from './search.component';
import { SearchParams, SearchResponse, SearchResult, SearchService } from '../api/search.service';
import { API_BASE_URL } from '../api/api-base-url.token';
import {
  RECENT_QUERIES_KEY,
  pushRecent,
  readRecents,
  topHitsFromResults,
  writeRecents,
} from './search-types';
import { splitLabel } from './top-hits-section.component';

/** In-memory SearchService stub. Tracks every call so tests can assert
 * debounce + cancel-in-flight + scope behaviour. */
class StubSearchService {
  readonly calls: SearchParams[] = [];
  /** Subjects keyed by call index — tests can complete or error each one. */
  readonly subjects: Subject<SearchResponse>[] = [];
  /** Default response when no test override. */
  defaultResponse: SearchResponse = { total: 0, page: 0, limit: 30, results: [] };

  search(params: SearchParams): Observable<SearchResponse> {
    this.calls.push(params);
    const subj = new Subject<SearchResponse>();
    this.subjects.push(subj);
    return new Observable((subscriber) => {
      const sub = subj.subscribe({
        next: (r) => subscriber.next(r),
        complete: () => subscriber.complete(),
        error: (e) => subscriber.error(e),
      });
      return () => sub.unsubscribe();
    });
  }

  /** Resolve the most recent call with the default response. */
  resolveLatest(response?: SearchResponse): void {
    const subj = this.subjects[this.subjects.length - 1];
    subj.next(response ?? this.defaultResponse);
    subj.complete();
  }

  facets() {
    return of({});
  }
  buckets() {
    return of({});
  }
}

function makeResult(id: string, filename: string): SearchResult {
  return {
    id: `fs:/path/${id}`,
    address: null,
    _id: id,
    folder_id: 'f1',
    abs_path: `/path/${filename}`,
    filename,
    size: 1000,
    mtime: 0,
    captured_at: null,
    camera: { make: 'Hasselblad', model: 'L3D-100c' },
    lens: null,
    iso: null,
    aperture: null,
    shutter: null,
    focal_length: null,
    rating: 0,
    flag: 0,
    color_label: '',
  };
}

function typeInput(fixture: ComponentFixture<SearchComponent>, value: string): void {
  const bar = fixture.nativeElement.querySelector(
    '[data-testid="search-input"]',
  ) as HTMLInputElement;
  bar.value = value;
  bar.dispatchEvent(new Event('input'));
  fixture.detectChanges();
}

describe('SearchComponent', () => {
  let fixture: ComponentFixture<SearchComponent>;
  let component: SearchComponent;
  let stubService: StubSearchService;

  beforeEach(async () => {
    vi.useFakeTimers();
    stubService = new StubSearchService();
    localStorage.removeItem(RECENT_QUERIES_KEY);
    await TestBed.configureTestingModule({
      imports: [SearchComponent],
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        { provide: API_BASE_URL, useValue: '/api' },
        { provide: SearchService, useValue: stubService },
      ],
    }).compileComponents();
    fixture = TestBed.createComponent(SearchComponent);
    component = fixture.componentInstance;
    fixture.detectChanges();
  });

  afterEach(() => {
    vi.useRealTimers();
    localStorage.removeItem(RECENT_QUERIES_KEY);
  });

  it('renders the search root', () => {
    const root = fixture.nativeElement.querySelector('[data-testid="search-root"]');
    expect(root).toBeTruthy();
  });

  it('shows only recents when query is empty', () => {
    const noResults = fixture.nativeElement.querySelector('[data-testid="search-no-results"]');
    const photoSec = fixture.nativeElement.querySelector('[data-testid="photo-results-section"]');
    expect(noResults).toBeNull();
    expect(photoSec).toBeNull();
  });

  it('keeps the recents-only state when the user types only whitespace', () => {
    // Whitespace-only input must behave like an empty query — the search
    // effect trims before hitting the API, and `showRecents` / `hasQuery`
    // must agree so the body isn't blank (no recents, no results, no empty
    // state). Regression guard for the Copilot review on #629.
    typeInput(fixture, '   ');
    vi.advanceTimersByTime(300);
    fixture.detectChanges();
    expect(stubService.calls.length).toBe(0);
    const noResults = fixture.nativeElement.querySelector('[data-testid="search-no-results"]');
    const photoSec = fixture.nativeElement.querySelector('[data-testid="photo-results-section"]');
    expect(noResults).toBeNull();
    expect(photoSec).toBeNull();
  });

  it('debounces rapid keystrokes into one fetch after 250ms', () => {
    typeInput(fixture, 'p');
    vi.advanceTimersByTime(50);
    typeInput(fixture, 'pa');
    vi.advanceTimersByTime(50);
    typeInput(fixture, 'par');
    vi.advanceTimersByTime(50);
    typeInput(fixture, 'pari');
    vi.advanceTimersByTime(50);
    typeInput(fixture, 'paris');

    expect(stubService.calls.length).toBe(0); // still inside debounce window
    vi.advanceTimersByTime(250);
    expect(stubService.calls.length).toBe(1);
    expect(stubService.calls[0].placeQuery).toBe('paris');
    stubService.resolveLatest();
  });

  it('sends the term as placeQuery (content search), not q (filename match)', () => {
    // The single responsive search box is the *content* search — it must hit
    // the unified search_blob (place + caption + OCR + people, NL-dates,
    // semantic ranking) via `placeQuery`, exactly like the advanced search
    // box. Sending `q` (filename substring) instead returns nothing for the
    // normal "search my photos for Paris / a person / a caption" case.
    typeInput(fixture, 'paris');
    vi.advanceTimersByTime(300);
    expect(stubService.calls.length).toBe(1);
    expect(stubService.calls[0]!.placeQuery).toBe('paris');
    expect(stubService.calls[0]!.q).toBeUndefined();
    stubService.resolveLatest();
  });

  it('renders no-results message when results are empty', () => {
    typeInput(fixture, 'paris');
    vi.advanceTimersByTime(300);
    stubService.resolveLatest();
    fixture.detectChanges();
    const empty = fixture.nativeElement.querySelector('[data-testid="search-no-results"]');
    expect(empty).toBeTruthy();
    expect((empty as HTMLElement).textContent).toContain('paris');
  });

  it('renders photo grid when results arrive', () => {
    typeInput(fixture, 'paris');
    vi.advanceTimersByTime(300);
    stubService.resolveLatest({
      total: 12,
      page: 0,
      limit: 30,
      results: [makeResult('a', 'a.dng'), makeResult('b', 'b.dng')],
    });
    fixture.detectChanges();
    const section = fixture.nativeElement.querySelector('[data-testid="photo-results-section"]');
    expect(section).toBeTruthy();
    expect((section as HTMLElement).textContent).toContain('12');
    const tiles = fixture.nativeElement.querySelectorAll('[data-testid^="search-tile-"]');
    expect(tiles.length).toBe(2);
  });

  it('emits photoTap and persists recent on tile click', () => {
    let captured: SearchResult | null = null;
    component.photoTap.subscribe((r) => {
      captured = r;
    });
    typeInput(fixture, 'paris');
    vi.advanceTimersByTime(300);
    stubService.resolveLatest({
      total: 1,
      page: 0,
      limit: 30,
      results: [makeResult('a', 'a.dng')],
    });
    fixture.detectChanges();
    const tile = fixture.nativeElement.querySelector(
      '[data-testid="search-tile-fs:/path/a"]',
    ) as HTMLElement;
    tile.click();
    expect(captured).not.toBeNull();
    expect((captured as unknown as SearchResult).filename).toBe('a.dng');
    expect(readRecents()).toEqual(['paris']);
  });

  it('issues a new search on scope change', () => {
    typeInput(fixture, 'paris');
    vi.advanceTimersByTime(300);
    stubService.resolveLatest();
    fixture.detectChanges();
    expect(stubService.calls.length).toBe(1);

    const photosChip = fixture.nativeElement.querySelector(
      '[data-testid="search-scope-photos"]',
    ) as HTMLElement;
    photosChip.click();
    fixture.detectChanges();
    vi.advanceTimersByTime(300);
    expect(stubService.calls.length).toBe(2);
  });

  it('clears query and results when ✕ tapped', () => {
    typeInput(fixture, 'paris');
    vi.advanceTimersByTime(300);
    stubService.resolveLatest({
      total: 1,
      page: 0,
      limit: 30,
      results: [makeResult('a', 'a.dng')],
    });
    fixture.detectChanges();
    const clear = fixture.nativeElement.querySelector(
      '[data-testid="search-clear"]',
    ) as HTMLElement;
    clear.click();
    fixture.detectChanges();
    const empty = fixture.nativeElement.querySelector('[data-testid="search-no-results"]');
    expect(empty).toBeNull();
  });

  // ── Infinite-scroll pagination (onLoadMore) + Filters ────────────────────

  function loadPageZero(total: number): void {
    typeInput(fixture, 'paris');
    vi.advanceTimersByTime(300);
    stubService.resolveLatest({
      total,
      page: 0,
      limit: 30,
      results: Array.from({ length: 30 }, (_, i) => makeResult('p0-' + i, 'p0-' + i + '.dng')),
    });
    fixture.detectChanges();
  }

  it('onLoadMore fetches the next page and appends results', () => {
    loadPageZero(60);
    (component as any).onLoadMore();
    expect(stubService.calls.length).toBe(2);
    expect(stubService.calls[1].page).toBe(1);
    expect(stubService.calls[1].placeQuery).toBe('paris');
    stubService.resolveLatest({
      total: 60,
      page: 1,
      limit: 30,
      results: Array.from({ length: 30 }, (_, i) => makeResult('p1-' + i, 'p1-' + i + '.dng')),
    });
    fixture.detectChanges();
    expect((component as any).results().length).toBe(60);
    expect((component as any).page()).toBe(1);
  });

  it('onLoadMore is a no-op while a fresh search is debouncing (isStale)', () => {
    loadPageZero(60);
    typeInput(fixture, 'beach'); // new query debouncing → isStale, not yet fired
    (component as any).onLoadMore();
    expect(stubService.calls.length).toBe(1); // no page-1 for the stale set
  });

  it('onLoadMore guards against duplicate concurrent loads', () => {
    loadPageZero(90);
    (component as any).onLoadMore(); // page 1 in flight
    (component as any).onLoadMore(); // ignored — already loading
    expect(stubService.calls.length).toBe(2);
  });

  it('onFilters commits the query to recents', () => {
    typeInput(fixture, 'paris');
    vi.advanceTimersByTime(300);
    stubService.resolveLatest();
    (component as any).onFilters();
    expect(readRecents()).toContain('paris');
  });

  it('emits queryChange output on query changes, clear, and recent tap', () => {
    const emissions: string[] = [];
    component.queryChange.subscribe((q) => {
      emissions.push(q);
    });

    // 1. Typing in input
    typeInput(fixture, 'paris');
    expect(emissions).toEqual(['paris']);

    // 2. Clearing the search
    (component as any).onClear();
    expect(emissions).toEqual(['paris', '']);

    // 3. Tapping a recent search
    (component as any).onRecentTap('berlin');
    expect(emissions).toEqual(['paris', '', 'berlin']);
  });
});

describe('SearchComponent initialQuery seeding', () => {
  // Regression guard: the toolbar search (browse-shell) and the drawer search
  // pill navigate to `/search?q=…`. The host page reads `?q` and feeds it in
  // through the `initialQuery` input — without seeding, the landing page is
  // blank and the user's query is silently dropped at the route boundary.
  let fixture: ComponentFixture<SearchComponent>;
  let stubService: StubSearchService;

  beforeEach(async () => {
    vi.useFakeTimers();
    stubService = new StubSearchService();
    localStorage.removeItem(RECENT_QUERIES_KEY);
    await TestBed.configureTestingModule({
      imports: [SearchComponent],
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        { provide: API_BASE_URL, useValue: '/api' },
        { provide: SearchService, useValue: stubService },
      ],
    }).compileComponents();
    fixture = TestBed.createComponent(SearchComponent);
    // NOTE: no detectChanges() here — the seed must be applied BEFORE the first
    // change-detection run so ngOnInit reads the bound input.
  });

  afterEach(() => {
    vi.useRealTimers();
    localStorage.removeItem(RECENT_QUERIES_KEY);
  });

  it('seeds the bar and issues a search from initialQuery', () => {
    fixture.componentRef.setInput('initialQuery', 'paris');
    fixture.detectChanges();

    const input = fixture.nativeElement.querySelector(
      '[data-testid="search-input"]',
    ) as HTMLInputElement;
    expect(input.value).toBe('paris');

    vi.advanceTimersByTime(300);
    expect(stubService.calls.length).toBe(1);
    expect(stubService.calls[0]!.placeQuery).toBe('paris');
    stubService.resolveLatest();
  });

  it('does not search when initialQuery is empty', () => {
    fixture.detectChanges();
    vi.advanceTimersByTime(300);
    expect(stubService.calls.length).toBe(0);
  });

  it('ignores a whitespace-only initialQuery', () => {
    fixture.componentRef.setInput('initialQuery', '   ');
    fixture.detectChanges();
    vi.advanceTimersByTime(300);
    // Trims to empty → bar stays blank, no fetch, no results/empty-state body.
    expect(stubService.calls.length).toBe(0);
    const input = fixture.nativeElement.querySelector(
      '[data-testid="search-input"]',
    ) as HTMLInputElement;
    expect(input.value).toBe('');
    const photoSec = fixture.nativeElement.querySelector('[data-testid="photo-results-section"]');
    expect(photoSec).toBeNull();
  });
});

describe('search-types helpers', () => {
  beforeEach(() => localStorage.removeItem(RECENT_QUERIES_KEY));
  afterEach(() => localStorage.removeItem(RECENT_QUERIES_KEY));

  it('caps recents at 10 with most-recent first', () => {
    let list: string[] = [];
    for (let i = 0; i < 15; i++) list = pushRecent(list, `q${i}`);
    expect(list.length).toBe(10);
    expect(list[0]).toBe('q14');
    expect(list[9]).toBe('q5');
  });

  it('dedups recent queries', () => {
    let list = pushRecent([], 'paris');
    list = pushRecent(list, 'london');
    list = pushRecent(list, 'paris');
    expect(list).toEqual(['paris', 'london']);
  });

  it('ignores empty / whitespace queries', () => {
    expect(pushRecent(['a'], '')).toEqual(['a']);
    expect(pushRecent(['a'], '   ')).toEqual(['a']);
  });

  it('round-trips through localStorage', () => {
    writeRecents(['paris', 'london']);
    expect(readRecents()).toEqual(['paris', 'london']);
  });

  it('derives top hits from results head', () => {
    const r = [1, 2, 3, 4, 5].map((i) => ({
      id: `id${i}`,
      address: null,
      _id: `${i}`,
      folder_id: 'f',
      abs_path: `/p/${i}`,
      filename: `${i}.dng`,
      size: 0,
      mtime: 0,
      captured_at: null,
      camera: null,
      lens: null,
      iso: null,
      aperture: null,
      shutter: null,
      focal_length: null,
      rating: 0,
      flag: 0 as const,
      color_label: '',
    }));
    const top = topHitsFromResults(r);
    expect(top.length).toBe(3);
    expect(top.every((h) => h.kind === 'photo')).toBe(true);
  });
});

describe('splitLabel', () => {
  it('returns one non-highlight segment when query is empty', () => {
    expect(splitLabel('Paris', '')).toEqual([{ text: 'Paris', highlight: false }]);
  });

  it('highlights a case-insensitive substring match', () => {
    const segs = splitLabel('Old Paris', 'paris');
    expect(segs).toEqual([
      { text: 'Old ', highlight: false },
      { text: 'Paris', highlight: true },
    ]);
  });

  it('highlights each whitespace-separated token', () => {
    const segs = splitLabel('Old Paris Streets', 'old streets');
    expect(segs[0]).toEqual({ text: 'Old', highlight: true });
    expect(segs[segs.length - 1]).toEqual({ text: 'Streets', highlight: true });
  });
});

describe('scopeToParams', () => {
  it('maps "all" to an empty SearchParams (default server set)', () => {
    expect(scopeToParams('all')).toEqual({});
  });

  it('forwards the chip value as the server-side scope param', () => {
    expect(scopeToParams('photos')).toEqual({ scope: 'photos' });
    expect(scopeToParams('places')).toEqual({ scope: 'places' });
    expect(scopeToParams('people')).toEqual({ scope: 'people' });
    expect(scopeToParams('albums')).toEqual({ scope: 'albums' });
  });
});

describe('SearchComponent scope flow', () => {
  let fixture: ComponentFixture<SearchComponent>;
  let stubService: StubSearchService;

  beforeEach(async () => {
    vi.useFakeTimers();
    stubService = new StubSearchService();
    localStorage.removeItem(RECENT_QUERIES_KEY);
    await TestBed.configureTestingModule({
      imports: [SearchComponent],
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        { provide: API_BASE_URL, useValue: '/api' },
        { provide: SearchService, useValue: stubService },
      ],
    }).compileComponents();
    fixture = TestBed.createComponent(SearchComponent);
    fixture.detectChanges();
  });

  afterEach(() => {
    vi.useRealTimers();
    localStorage.removeItem(RECENT_QUERIES_KEY);
  });

  it('tapping the Places chip re-issues the query with scope=places', () => {
    typeInput(fixture, 'paris');
    vi.advanceTimersByTime(300);
    stubService.resolveLatest();
    fixture.detectChanges();
    expect(stubService.calls.length).toBe(1);
    expect(stubService.calls[0]!.scope).toBeUndefined();

    const placesChip = fixture.nativeElement.querySelector(
      '[data-testid="search-scope-places"]',
    ) as HTMLElement;
    placesChip.click();
    fixture.detectChanges();
    vi.advanceTimersByTime(300);
    expect(stubService.calls.length).toBe(2);
    expect(stubService.calls[1]!.scope).toBe('places');
    expect(stubService.calls[1]!.placeQuery).toBe('paris');
  });

  it('tapping the People chip sends scope=people', () => {
    typeInput(fixture, 'beach');
    vi.advanceTimersByTime(300);
    stubService.resolveLatest();
    fixture.detectChanges();

    const peopleChip = fixture.nativeElement.querySelector(
      '[data-testid="search-scope-people"]',
    ) as HTMLElement;
    peopleChip.click();
    fixture.detectChanges();
    vi.advanceTimersByTime(300);
    expect(stubService.calls.at(-1)!.scope).toBe('people');
  });

  it('tapping the Albums chip sends scope=albums', () => {
    typeInput(fixture, 'trip');
    vi.advanceTimersByTime(300);
    stubService.resolveLatest();
    fixture.detectChanges();

    const albumsChip = fixture.nativeElement.querySelector(
      '[data-testid="search-scope-albums"]',
    ) as HTMLElement;
    albumsChip.click();
    fixture.detectChanges();
    vi.advanceTimersByTime(300);
    expect(stubService.calls.at(-1)!.scope).toBe('albums');
  });
});

describe('SearchService param serialisation', () => {
  it('serialises SearchParams.scope onto the HTTP query', async () => {
    let captured: HttpTestingController | null = null;
    await TestBed.configureTestingModule({
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        { provide: API_BASE_URL, useValue: '/api' },
        SearchService,
      ],
    }).compileComponents();

    const svc = TestBed.inject(SearchService);
    captured = TestBed.inject(HttpTestingController);

    svc.search({ q: 'paris', scope: 'places' }).subscribe();
    const req = captured.expectOne((r) => r.url === '/api/search');
    expect(req.request.params.get('scope')).toBe('places');
    expect(req.request.params.get('q')).toBe('paris');
    req.flush({ total: 0, page: 0, limit: 100, results: [] });
    captured.verify();
  });

  it('omits the scope param when SearchParams.scope is undefined', async () => {
    await TestBed.configureTestingModule({
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        { provide: API_BASE_URL, useValue: '/api' },
        SearchService,
      ],
    }).compileComponents();

    const svc = TestBed.inject(SearchService);
    const ctrl = TestBed.inject(HttpTestingController);
    svc.search({ q: 'paris' }).subscribe();
    const req = ctrl.expectOne((r) => r.url === '/api/search');
    expect(req.request.params.has('scope')).toBe(false);
    req.flush({ total: 0, page: 0, limit: 100, results: [] });
    ctrl.verify();
  });
});
