// SearchPageComponent (Self-Hosted) — route-wiring tests.
//
// The browse-shell toolbar and the drawer search pill navigate to
// `/search?q=<query>`. This page is the `/search` host: it must read `?q`
// off the route and seed the embedded `<app-search>` so the landing page
// shows the user's query and fires the search — otherwise the query is
// dropped at the route boundary and the page renders blank (the post-redesign
// regression this guards).
//
// Fake timers pump the 250ms debounce inside `<app-search>` — same pattern as
// search.component.spec.ts (the unit-test runner has no zone-testing).

import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { provideHttpClientTesting } from '@angular/common/http/testing';
import { ActivatedRoute, Router, convertToParamMap } from '@angular/router';
import { Observable, Subject } from 'rxjs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  API_BASE_URL,
  HttpLibrarySource,
  LIBRARY_SOURCE,
  RECENT_QUERIES_KEY,
  SearchParams,
  SearchResponse,
  SearchService,
} from '@maple-common';
import { SearchPageComponent } from './search-page.component';

class StubSearchService {
  readonly calls: SearchParams[] = [];
  readonly subjects: Subject<SearchResponse>[] = [];
  search(params: SearchParams): Observable<SearchResponse> {
    this.calls.push(params);
    const subj = new Subject<SearchResponse>();
    this.subjects.push(subj);
    return new Observable((sub) => subj.subscribe(sub));
  }
  // The unified page also fetches facets (panel rows / tag picker); these
  // tests never resolve it — a hanging observable is enough.
  facets(): Observable<never> {
    return new Observable<never>(() => {});
  }
}

function setup(q?: string): {
  fixture: ComponentFixture<SearchPageComponent>;
  stub: StubSearchService;
} {
  const stub = new StubSearchService();
  const route = { snapshot: { queryParamMap: convertToParamMap(q !== undefined ? { q } : {}) } };
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({
    imports: [SearchPageComponent],
    providers: [
      provideHttpClient(),
      provideHttpClientTesting(),
      { provide: ActivatedRoute, useValue: route },
      { provide: Router, useValue: { navigate: vi.fn() } },
      { provide: SearchService, useValue: stub },
      { provide: API_BASE_URL, useValue: '/api' },
      // Self Hosted: FilesystemBrowseService resolves result thumbnails
      // through LIBRARY_SOURCE (#1325), bound app-wide to HttpLibrarySource.
      { provide: LIBRARY_SOURCE, useExisting: HttpLibrarySource },
    ],
  });
  const fixture = TestBed.createComponent(SearchPageComponent);
  return { fixture, stub };
}

describe('SearchPageComponent (Self-Hosted) ?q wiring', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    // Scope to the recents key — `<app-search>` persists there. A blanket
    // localStorage.clear() would wipe unrelated keys in the shared jsdom.
    localStorage.removeItem(RECENT_QUERIES_KEY);
  });
  afterEach(() => {
    vi.useRealTimers();
    localStorage.removeItem(RECENT_QUERIES_KEY);
  });

  it('seeds the search bar and fires a search from ?q', () => {
    const { fixture, stub } = setup('paris');
    fixture.detectChanges();

    const input = fixture.nativeElement.querySelector(
      '[data-testid="search-input"]',
    ) as HTMLInputElement;
    expect(input.value).toBe('paris');

    vi.advanceTimersByTime(300);
    expect(stub.calls.length).toBe(1);
    expect(stub.calls[0]!.placeQuery).toBe('paris');
  });

  it('renders an empty bar and fires no search when ?q is absent', () => {
    const { fixture, stub } = setup();
    fixture.detectChanges();

    const input = fixture.nativeElement.querySelector(
      '[data-testid="search-input"]',
    ) as HTMLInputElement;
    expect(input.value).toBe('');

    vi.advanceTimersByTime(300);
    expect(stub.calls.length).toBe(0);
  });

  it('navigates to sync query parameters on queryChange output', () => {
    const { fixture } = setup();
    fixture.detectChanges();
    const router = TestBed.inject(Router);

    const searchComp = fixture.componentInstance['searchEl'];
    expect(searchComp).toBeTruthy();
    searchComp!.queryChange.emit('paris');

    expect(router.navigate).toHaveBeenCalledWith([], {
      relativeTo: expect.any(Object),
      queryParams: { q: 'paris' },
      replaceUrl: true,
    });
  });

  it('navigates via viewRouteCommands preferring address over id on onPhotoTap', () => {
    const { fixture } = setup();
    fixture.detectChanges();
    const router = TestBed.inject(Router);

    const hit = {
      id: 'fs:/srv/photos/a.jpg',
      address: 'photos:a.jpg',
      _id: 'mongo1',
      folder_id: 'f1',
      abs_path: '/srv/photos/a.jpg',
      filename: 'a.jpg',
      size: 100,
      mtime: 123,
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
    };

    fixture.componentInstance['onPhotoTap'](hit);
    expect(router.navigate).toHaveBeenCalledWith(['/view', 'photos', 'a.jpg']);

    const hitNoAddress = { ...hit, address: null };
    fixture.componentInstance['onPhotoTap'](hitNoAddress);
    expect(router.navigate).toHaveBeenCalledWith(['/view', 'fs:/srv/photos/a.jpg']);
  });
});
