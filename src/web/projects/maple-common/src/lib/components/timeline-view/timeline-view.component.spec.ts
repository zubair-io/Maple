// TimelineView — component-level test that exercises the bucket → header
// rendering path. The buckets request is the only async work we drive; the
// per-month fetch is gated by IntersectionObserver so we don't trigger it
// here.

import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { provideHttpClientTesting } from '@angular/common/http/testing';
import { provideRouter } from '@angular/router';
import { Subject, of } from 'rxjs';
import { describe, it, expect, beforeEach, vi } from 'vitest';

import { TimelineViewComponent } from './timeline-view.component';
import { LibraryStateService } from '../../state/library-state.service';
import { TimelineStateService } from '../../state/timeline-state.service';
import { SearchService, TimelineBuckets, SearchResponse } from '../../api/search.service';
import { FilesystemBrowseService } from '../../api/filesystem-browse.service';
import { LIBRARY_BACKEND } from '../../api/library-backend.token';
import { API_BASE_URL } from '../../api/api-base-url.token';

class SearchStub {
  bucketsCalls: unknown[] = [];
  bucketsResult: TimelineBuckets = {
    total: 4,
    buckets: [
      { year: 2026, month: 5, count: 2 },
      { year: 2026, month: 4, count: 1 },
      { year: 2025, month: 12, count: 1 },
    ],
    untimed_count: 7,
  };
  buckets = vi.fn((p: unknown) => {
    this.bucketsCalls.push(p);
    return of(this.bucketsResult);
  });
  search = vi.fn(() => of({ total: 0, page: 0, limit: 200, results: [] } as SearchResponse));
  facets = vi.fn(() => of({}));
}

class FsBrowseStub {
  getThumbBlobUrl = vi.fn(() => Promise.resolve('blob:fake'));
}

describe('TimelineViewComponent', () => {
  let library: LibraryStateService;
  let timeline: TimelineStateService;
  let searchStub: SearchStub;

  // Recording stubs so tests can verify the observer was actually
  // constructed with a non-null root and that month sections were
  // observe()'d. The lazy-wiring bug fixed in 7ca69b9 / f015bb8 was
  // invisible to no-op stubs.
  let ioCalls: Array<{ root: Element | null; callbacks: IntersectionObserverCallback }> = [];
  let ioObservedTargets: HTMLElement[] = [];

  beforeEach(() => {
    ioCalls = [];
    ioObservedTargets = [];
    const ioStub = class {
      constructor(callback: IntersectionObserverCallback, options?: IntersectionObserverInit) {
        ioCalls.push({
          root: (options?.root as Element | null) ?? null,
          callbacks: callback,
        });
      }
      observe(t: Element): void {
        ioObservedTargets.push(t as HTMLElement);
      }
      unobserve(): void {}
      disconnect(): void {}
    };
    const roStub = class {
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    };
    (globalThis as { ResizeObserver?: unknown }).ResizeObserver = roStub;
    (globalThis as { IntersectionObserver?: unknown }).IntersectionObserver = ioStub;

    searchStub = new SearchStub();
    TestBed.configureTestingModule({
      providers: [
        provideRouter([]),
        provideHttpClient(),
        provideHttpClientTesting(),
        { provide: LIBRARY_BACKEND, useValue: 'self-hosted' },
        { provide: API_BASE_URL, useValue: '/api' },
        { provide: SearchService, useValue: searchStub },
        { provide: FilesystemBrowseService, useValue: new FsBrowseStub() },
      ],
    });
    library = TestBed.inject(LibraryStateService);
    timeline = TestBed.inject(TimelineStateService);
    library.sidebarTree.set([
      {
        kind: 'folder',
        id: 'fs:/Lib',
        label: 'Lib',
        count: null,
        absPath: '/Lib',
      },
    ]);
  });

  it('renders empty-state copy when no scope is selected', () => {
    library.selectedSourceId.set('');
    const fixture = TestBed.createComponent(TimelineViewComponent);
    fixture.detectChanges();
    expect(fixture.nativeElement.textContent).toContain('Pick a library or folder');
    expect(searchStub.buckets).not.toHaveBeenCalled();
  });

  it('renders Year + Month headers with counts after buckets resolve', async () => {
    library.selectedSourceId.set('fs:/Lib');
    const fixture = TestBed.createComponent(TimelineViewComponent);
    fixture.detectChanges();
    // Buckets fetch is debounced 250 ms.
    await new Promise((r) => setTimeout(r, 300));
    fixture.detectChanges();

    expect(searchStub.buckets).toHaveBeenCalled();
    const params = searchStub.bucketsCalls[0] as { pathPrefix?: string; hasCapturedAt?: boolean };
    expect(params.pathPrefix).toBe('/Lib/');
    expect(params.hasCapturedAt).toBe(true);

    const html = fixture.nativeElement.textContent as string;
    // Year groupings: 2026 has 3 photos (2 May + 1 April), 2025 has 1.
    expect(html).toContain('2026');
    expect(html).toContain('3 photos');
    expect(html).toContain('2025');
    expect(html).toContain('1 photo');
    // Month sub-headers.
    expect(html).toContain('May');
    expect(html).toContain('April');
    expect(html).toContain('December');
  });

  it('shows the untimed-photos hint banner when untimed_count > 0', async () => {
    library.selectedSourceId.set('fs:/Lib');
    const fixture = TestBed.createComponent(TimelineViewComponent);
    fixture.detectChanges();
    await new Promise((r) => setTimeout(r, 300));
    fixture.detectChanges();
    expect(fixture.nativeElement.textContent).toContain('7 untimed photos hidden');
  });

  it('wires IntersectionObserver against the live #scrollContainer (not a stale ref)', async () => {
    library.selectedSourceId.set('fs:/Lib');
    const fixture = TestBed.createComponent(TimelineViewComponent);
    fixture.detectChanges();

    // Wait for the debounced buckets refresh + the per-month directive
    // ngOnInit to fire after the @for loop renders.
    await new Promise((r) => setTimeout(r, 300));
    fixture.detectChanges();
    await new Promise((r) => setTimeout(r, 0));
    fixture.detectChanges();

    // The IntersectionObserver must exist and its root must be the
    // #scrollContainer that's currently in the DOM — not a stale node
    // that was unmounted by an intermediate "Loading timeline…" branch.
    expect(ioCalls.length).toBeGreaterThanOrEqual(1);
    const liveRoot = fixture.nativeElement.querySelector('.timeline-scroll') as HTMLElement;
    expect(liveRoot).not.toBeNull();
    const lastObserver = ioCalls[ioCalls.length - 1]!;
    expect(lastObserver.root).toBe(liveRoot);

    // Every month section from the bucket fixture (3 months) must have
    // been observe()'d.
    expect(ioObservedTargets.length).toBe(3);
    for (const el of ioObservedTargets) {
      expect(el.dataset['year']).toBeTruthy();
      expect(el.dataset['month']).toBeTruthy();
      // The observed element must be a descendant of the live root —
      // catches the "observer wired to detached DOM" bug.
      expect(liveRoot.contains(el)).toBe(true);
    }
  });

  it('refetches buckets when a filter signal changes (debounced)', async () => {
    library.selectedSourceId.set('fs:/Lib');
    const fixture = TestBed.createComponent(TimelineViewComponent);
    fixture.detectChanges();
    await new Promise((r) => setTimeout(r, 300));
    expect(searchStub.buckets).toHaveBeenCalledTimes(1);

    timeline.setMinRating(4);
    fixture.detectChanges();
    await new Promise((r) => setTimeout(r, 300));
    expect(searchStub.buckets).toHaveBeenCalledTimes(2);
    const last = searchStub.bucketsCalls[1] as { rating?: number };
    expect(last.rating).toBe(4);
  });
});
