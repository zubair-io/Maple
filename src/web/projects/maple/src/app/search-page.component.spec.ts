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
import { API_BASE_URL, SearchParams, SearchResponse, SearchService } from '@maple-common';
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
    ],
  });
  const fixture = TestBed.createComponent(SearchPageComponent);
  return { fixture, stub };
}

describe('SearchPageComponent (Self-Hosted) ?q wiring', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    localStorage.clear();
  });
  afterEach(() => {
    vi.useRealTimers();
    localStorage.clear();
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
});
