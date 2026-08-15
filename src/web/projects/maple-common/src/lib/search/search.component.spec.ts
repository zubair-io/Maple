// SearchComponent — unit tests for the unified search page (#2865).
//
// We use vitest's fake timers (vi.useFakeTimers / advanceTimersByTime) to
// pump the 250ms search / 400ms facets debounces — Angular's `fakeAsync`
// requires zone-testing, which the @angular/build:unit-test runner does
// NOT bundle. Pattern matches `library-state.service.spec.ts`.

import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { provideHttpClientTesting } from '@angular/common/http/testing';
import { Observable, Subject } from 'rxjs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SearchComponent } from './search.component';
import {
  SearchFacets,
  SearchParams,
  SearchResponse,
  SearchResult,
  SearchService,
} from '../api/search.service';
import { FilesystemBrowseService } from '../api/filesystem-browse.service';
import { API_BASE_URL } from '../api/api-base-url.token';
import { RECENT_QUERIES_KEY } from './search-types';

/** In-memory SearchService stub. Tracks every call so tests can assert
 * debounce + cancel-in-flight + filter param behaviour. */
class StubSearchService {
  readonly calls: SearchParams[] = [];
  readonly subjects: Subject<SearchResponse>[] = [];
  readonly facetCalls: Array<Omit<SearchParams, 'page' | 'limit' | 'sort'>> = [];
  readonly facetSubjects: Subject<SearchFacets>[] = [];
  defaultResponse: SearchResponse = { total: 0, page: 0, limit: 30, results: [] };
  defaultFacets: SearchFacets = {
    total: 0,
    cameras: [],
    lenses: [],
    extensions: [],
    iso_range: null,
    capture_range: null,
    scene_types: [],
    activities: [],
    subjects: [],
    is_screenshot: { true: 0, false: 0, unknown: 0 },
    people: [
      { value: 'Priya Patel', count: 812 },
      { value: 'Alex Chen', count: 604 },
    ],
    places: [
      { value: 'Portland, OR', count: 946 },
      { value: 'Kyoto', count: 158 },
    ],
  };

  search(params: SearchParams): Observable<SearchResponse> {
    this.calls.push(params);
    const subj = new Subject<SearchResponse>();
    this.subjects.push(subj);
    return subj.asObservable();
  }

  facets(params: Omit<SearchParams, 'page' | 'limit' | 'sort'>): Observable<SearchFacets> {
    this.facetCalls.push(params);
    const subj = new Subject<SearchFacets>();
    this.facetSubjects.push(subj);
    return subj.asObservable();
  }

  resolveLatest(response?: SearchResponse): void {
    const subj = this.subjects[this.subjects.length - 1];
    subj.next(response ?? this.defaultResponse);
    subj.complete();
  }

  resolveLatestFacets(facets?: SearchFacets): void {
    const subj = this.facetSubjects[this.facetSubjects.length - 1];
    subj.next(facets ?? this.defaultFacets);
    subj.complete();
  }
}

/** Thumb loads hang forever — tiles keep placeholders, no state churn. */
class StubFsService {
  getThumbBlobUrl(): Promise<string> {
    return new Promise<string>(() => {});
  }
}

/* prettier-ignore */
function makeResult(id: string, filename: string): SearchResult {
  return {
    id: `fs:/path/${id}`, address: null, _id: id, folder_id: 'f1', abs_path: `/path/${filename}`,
    filename, size: 1000, mtime: 0, captured_at: null, camera: { make: 'Hasselblad', model: 'L3D-100c' },
    lens: null, iso: null, aperture: null, shutter: null, focal_length: null, rating: 0, flag: 0, color_label: '',
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

function click(fixture: ComponentFixture<SearchComponent>, testid: string): void {
  const el = fixture.nativeElement.querySelector(`[data-testid="${testid}"]`) as HTMLElement;
  el.click();
  fixture.detectChanges();
}

describe('SearchComponent (unified search)', () => {
  let fixture: ComponentFixture<SearchComponent>;
  let stub: StubSearchService;

  beforeEach(async () => {
    vi.useFakeTimers();
    stub = new StubSearchService();
    localStorage.removeItem(RECENT_QUERIES_KEY);
    await TestBed.configureTestingModule({
      imports: [SearchComponent],
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        { provide: API_BASE_URL, useValue: '/api' },
        { provide: SearchService, useValue: stub },
        { provide: FilesystemBrowseService, useValue: new StubFsService() },
      ],
    }).compileComponents();
    fixture = TestBed.createComponent(SearchComponent);
    fixture.detectChanges();
  });

  afterEach(() => {
    vi.useRealTimers();
    localStorage.removeItem(RECENT_QUERIES_KEY);
  });

  it('debounces keystrokes into one placeQuery fetch (never `q`)', () => {
    typeInput(fixture, 'p');
    typeInput(fixture, 'pa');
    typeInput(fixture, 'paris');
    vi.advanceTimersByTime(249);
    expect(stub.calls.length).toBe(0);
    vi.advanceTimersByTime(1);
    expect(stub.calls.length).toBe(1);
    expect(stub.calls[0].placeQuery).toBe('paris');
    expect(stub.calls[0].q).toBeUndefined();
    expect(stub.calls[0].page).toBe(0);
    expect(stub.calls[0].limit).toBe(30);
    // Text searches rank by relevance — no sort param is sent.
    expect(stub.calls[0].sort).toBeUndefined();
  });

  it('fires a filters-only search (no text) with sort + filter params', () => {
    click(fixture, 'filter-preset-thisYear');
    vi.advanceTimersByTime(250);
    expect(stub.calls.length).toBe(1);
    expect(stub.calls[0].placeQuery).toBeUndefined();
    expect(stub.calls[0].from).toBe(`${new Date().getFullYear()}-01-01`);
    expect(stub.calls[0].sort).toBe('captured_desc');
  });

  it('selecting people/places in the panel sends people/place params and inline chips render', () => {
    // Populate panel rows via the facets fetch.
    vi.advanceTimersByTime(400);
    stub.resolveLatestFacets();
    fixture.detectChanges();
    click(fixture, 'filter-person-Priya Patel');
    click(fixture, 'filter-place-Portland, OR');
    vi.advanceTimersByTime(250);
    const last = stub.calls[stub.calls.length - 1];
    expect(last.people).toEqual(['Priya Patel']);
    expect(last.place).toEqual(['Portland, OR']);
    const chips = fixture.nativeElement.querySelectorAll('[data-testid="search-active-chip"]');
    expect(chips.length).toBe(2);
    // Badge shows the active count.
    expect(
      fixture.nativeElement.querySelector('[data-testid="search-filter-count"]')?.textContent,
    ).toContain('2');
  });

  it('caps inline chips at two and collapses the rest into +N', () => {
    vi.advanceTimersByTime(400);
    stub.resolveLatestFacets();
    fixture.detectChanges();
    click(fixture, 'filter-preset-last30');
    click(fixture, 'filter-person-Priya Patel');
    click(fixture, 'filter-place-Kyoto');
    const chips = fixture.nativeElement.querySelectorAll('[data-testid="search-active-chip"]');
    expect(chips.length).toBe(2);
    expect(
      fixture.nativeElement.querySelector('[data-testid="search-chip-overflow"]')?.textContent,
    ).toContain('+1');
  });

  it('removing a chip clears the filter and refetches', () => {
    vi.advanceTimersByTime(400);
    stub.resolveLatestFacets();
    fixture.detectChanges();
    click(fixture, 'filter-person-Priya Patel');
    vi.advanceTimersByTime(250);
    expect(stub.calls[stub.calls.length - 1].people).toEqual(['Priya Patel']);
    click(fixture, 'search-chip-remove-Priya Patel');
    vi.advanceTimersByTime(250);
    // Back to the empty state — the results meta row is gone and no new
    // search fired for the now-empty filter set.
    expect(fixture.nativeElement.querySelector('[data-testid="search-result-count"]')).toBeNull();
  });

  it('Clear all resets every filter', () => {
    vi.advanceTimersByTime(400);
    stub.resolveLatestFacets();
    fixture.detectChanges();
    click(fixture, 'filter-person-Priya Patel');
    click(fixture, 'filter-preset-today');
    click(fixture, 'filter-clear-all');
    expect(
      fixture.nativeElement.querySelectorAll('[data-testid="search-active-chip"]').length,
    ).toBe(0);
  });

  it('facets fetch carries the active filter set and drives "Show N results"', () => {
    vi.advanceTimersByTime(400);
    stub.resolveLatestFacets();
    fixture.detectChanges();
    click(fixture, 'filter-person-Priya Patel');
    vi.advanceTimersByTime(400);
    const lastFacets = stub.facetCalls[stub.facetCalls.length - 1];
    expect(lastFacets.people).toEqual(['Priya Patel']);
    stub.resolveLatestFacets({ ...stub.defaultFacets, total: 812 });
    fixture.detectChanges();
    expect(
      fixture.nativeElement.querySelector('[data-testid="filter-apply"]')?.textContent,
    ).toContain('Show 812 results');
  });

  it('a trailing @token opens the tag picker without re-fetching, and a pick applies the filter', () => {
    typeInput(fixture, 'beach');
    vi.advanceTimersByTime(250);
    expect(stub.calls.length).toBe(1);
    // Facet data for the picker lists.
    vi.advanceTimersByTime(150);
    stub.resolveLatestFacets();
    fixture.detectChanges();

    typeInput(fixture, 'beach @');
    expect(fixture.nativeElement.querySelector('[data-testid="tag-picker"]')).toBeTruthy();
    typeInput(fixture, 'beach @pri');
    vi.advanceTimersByTime(250);
    // The token never reaches the server: effective text is unchanged, so
    // no new search fired for the @ keystrokes.
    expect(stub.calls.length).toBe(1);
    // Fragment filters the people list down to Priya.
    expect(fixture.nativeElement.querySelector('[data-testid="tag-person-Alex Chen"]')).toBeNull();
    click(fixture, 'tag-person-Priya Patel');
    vi.advanceTimersByTime(250);
    const last = stub.calls[stub.calls.length - 1];
    expect(last.placeQuery).toBe('beach');
    expect(last.people).toEqual(['Priya Patel']);
    // Token consumed — the input holds the residual text.
    const input = fixture.nativeElement.querySelector(
      '[data-testid="search-input"]',
    ) as HTMLInputElement;
    expect(input.value).toBe('beach');
    expect(fixture.nativeElement.querySelector('[data-testid="tag-picker"]')).toBeNull();
  });

  it('dismissing the tag picker keeps it closed until the token changes', () => {
    vi.advanceTimersByTime(400);
    stub.resolveLatestFacets();
    fixture.detectChanges();
    typeInput(fixture, '@po');
    expect(fixture.nativeElement.querySelector('[data-testid="tag-picker"]')).toBeTruthy();
    click(fixture, 'tag-picker-backdrop');
    expect(fixture.nativeElement.querySelector('[data-testid="tag-picker"]')).toBeNull();
    typeInput(fixture, '@por');
    expect(fixture.nativeElement.querySelector('[data-testid="tag-picker"]')).toBeTruthy();
  });

  it('renders results with the meta count and clears back to recents on empty', () => {
    typeInput(fixture, 'paris');
    vi.advanceTimersByTime(250);
    stub.resolveLatest({
      total: 2,
      page: 0,
      limit: 30,
      results: [makeResult('a', 'a.dng'), makeResult('b', 'b.dng')],
    });
    fixture.detectChanges();
    expect(
      fixture.nativeElement.querySelector('[data-testid="search-result-count"]')?.textContent,
    ).toContain('2 results');
    expect(fixture.nativeElement.querySelectorAll('[data-testid^="search-tile-"]').length).toBe(2);
    click(fixture, 'search-clear');
    vi.advanceTimersByTime(250);
    expect(stub.calls.length).toBe(1);
    expect(fixture.nativeElement.querySelector('[data-testid="search-result-count"]')).toBeNull();
    expect(fixture.nativeElement.querySelectorAll('[data-testid^="search-tile-"]').length).toBe(0);
  });

  it('shows the sort control only for filter-driven searches (text ranks by relevance)', () => {
    click(fixture, 'filter-preset-last7');
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('[data-testid="search-sort"]')).toBeTruthy();
    typeInput(fixture, 'paris');
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('[data-testid="search-sort"]')).toBeNull();
  });

  it('changing sort refetches with the new order', () => {
    click(fixture, 'filter-preset-last7');
    vi.advanceTimersByTime(250);
    const select = fixture.nativeElement.querySelector(
      '[data-testid="search-sort"]',
    ) as HTMLSelectElement;
    select.value = 'captured_asc';
    select.dispatchEvent(new Event('change'));
    fixture.detectChanges();
    vi.advanceTimersByTime(250);
    expect(stub.calls[stub.calls.length - 1].sort).toBe('captured_asc');
  });

  it('load-more seeks with the server cursor when one was minted', () => {
    click(fixture, 'filter-preset-thisYear');
    vi.advanceTimersByTime(250);
    stub.resolveLatest({
      total: 60,
      page: 0,
      limit: 30,
      results: Array.from({ length: 30 }, (_, i) => makeResult(`r${i}`, `r${i}.dng`)),
      cursorPaging: true,
      nextCursor: 'CURSOR-1',
    });
    fixture.detectChanges();
    (fixture.componentInstance as unknown as { onLoadMore(): void }).onLoadMore();
    expect(stub.calls[stub.calls.length - 1].cursor).toBe('CURSOR-1');
    expect(stub.calls[stub.calls.length - 1].page).toBeUndefined();
  });

  it('persists recents on submit and restores the query on recent tap', () => {
    typeInput(fixture, 'paris');
    const form = fixture.nativeElement.querySelector('form') as HTMLFormElement;
    form.dispatchEvent(new Event('submit'));
    fixture.detectChanges();
    expect(localStorage.getItem(RECENT_QUERIES_KEY)).toBe(JSON.stringify(['paris']));
    click(fixture, 'search-clear');
    fixture.detectChanges();
    click(fixture, 'recent-chip-paris');
    const input = fixture.nativeElement.querySelector(
      '[data-testid="search-input"]',
    ) as HTMLInputElement;
    expect(input.value).toBe('paris');
  });
});
