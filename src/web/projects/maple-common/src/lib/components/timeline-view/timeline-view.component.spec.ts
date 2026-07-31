// TimelineView — component-level test exercising the single-query
// pagination -> client-side Year/Month/folder fold path. See
// docs/superpowers/specs/2026-07-07-timeline-single-query-client-bucketing-design.md.

import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { provideHttpClientTesting } from '@angular/common/http/testing';
import { provideRouter, Router } from '@angular/router';
import { of } from 'rxjs';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

import { TimelineViewComponent } from './timeline-view.component';
import { MAX_CONCURRENT_THUMB_LOADS } from './timeline-thumb-loader';
import { LibraryStateService } from '../../state/library-state.service';
import { TimelineStateService } from '../../state/timeline-state.service';
import { SearchService, SearchParams } from '../../api/search.service';
import { FilesystemBrowseService } from '../../api/filesystem-browse.service';
import { LIBRARY_BACKEND } from '../../api/library-backend.token';
import { API_BASE_URL } from '../../api/api-base-url.token';
import { provideLibrarySource } from '../../addressing/library-source-provider';
import { FsBrowseStub, SearchStub, clearPrefKeys, makeResult } from './timeline-view.test-helpers';

beforeEach(clearPrefKeys);
afterEach(clearPrefKeys);

describe('TimelineViewComponent', () => {
  let library: LibraryStateService;
  let timeline: TimelineStateService;
  let searchStub: SearchStub;

  // Recording stub so tests can verify observer wiring AND manually fire
  // intersection callbacks (there's no real IntersectionObserver in
  // jsdom). visibilityObserver is constructed first, sentinelObserver
  // second — `ioCalls[1]` is always the sentinel one.
  let ioCalls: Array<{ root: Element | null; callbacks: IntersectionObserverCallback }> = [];
  let ioObservedTargets: HTMLElement[] = [];

  beforeEach(() => {
    ioCalls = [];
    ioObservedTargets = [];
    const ioStub = class {
      constructor(callback: IntersectionObserverCallback, options?: IntersectionObserverInit) {
        ioCalls.push({ root: (options?.root as Element | null) ?? null, callbacks: callback });
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
        provideLibrarySource,
        { provide: LIBRARY_BACKEND, useValue: 'self-hosted' },
        { provide: API_BASE_URL, useValue: '/api' },
        { provide: SearchService, useValue: searchStub },
        { provide: FilesystemBrowseService, useValue: new FsBrowseStub() },
      ],
    });
    library = TestBed.inject(LibraryStateService);
    timeline = TestBed.inject(TimelineStateService);
    library.registeredFolders.set([
      {
        id: 'lib-1',
        slug: 'lib',
        path: '/Lib',
        label: 'Lib',
        last_scan: null,
        file_count: 0,
        created_at: '2026-01-01T00:00:00.000Z',
      },
    ]);
    library.sidebarTree.set([
      { kind: 'folder', id: 'lib:', label: 'Lib', count: null, absPath: '/Lib' },
    ]);
  });

  it('renders empty-state copy when no scope is selected', () => {
    library.selectedSourceId.set('');
    const fixture = TestBed.createComponent(TimelineViewComponent);
    fixture.detectChanges();
    expect(fixture.nativeElement.textContent).toContain('Pick a library or folder');
    expect(searchStub.search).not.toHaveBeenCalled();
  });

  it('renders Year + Month headers from page 0 with a single sorted query, no buckets call', async () => {
    searchStub.pages = [
      {
        total: 3,
        page: 0,
        limit: 200,
        results: [
          makeResult('a', '/Lib/2026/a.dng', '2026-05-20T00:00:00.000Z'),
          makeResult('b', '/Lib/2026/b.dng', '2026-05-10T00:00:00.000Z'),
          makeResult('c', '/Lib/2026/c.dng', '2026-04-01T00:00:00.000Z'),
        ],
      },
    ];
    library.selectedSourceId.set('lib:');
    const fixture = TestBed.createComponent(TimelineViewComponent);
    fixture.detectChanges();
    await new Promise((r) => setTimeout(r, 300));
    fixture.detectChanges();

    expect(searchStub.search).toHaveBeenCalledTimes(1);
    const params = searchStub.searchCalls[0]!;
    expect(params.libraryId).toBe('lib-1');
    expect(params.pathPrefix).toBeUndefined();
    expect(params.hasCapturedAt).toBe(true);
    expect(params.sort).toBe('captured_desc');
    expect(params.page).toBe(0);

    const html = fixture.nativeElement.textContent as string;
    expect(html).toContain('2026');
    expect(html).toContain('3 photos');
    expect(html).toContain('May');
    expect(html).toContain('April');
  });

  it('loads correctly when the newest photo in scope is years old (the original bug)', async () => {
    searchStub.pages = [
      {
        total: 1,
        page: 0,
        limit: 200,
        results: [makeResult('a', '/Lib/2026/vacation/a.dng', '2018-03-15T00:00:00.000Z')],
      },
    ];
    library.selectedSourceId.set('lib:');
    const fixture = TestBed.createComponent(TimelineViewComponent);
    fixture.detectChanges();
    await new Promise((r) => setTimeout(r, 300));
    fixture.detectChanges();

    const html = fixture.nativeElement.textContent as string;
    expect(html).toContain('2018');
    expect(html).toContain('March');
    // No month-by-month walk: exactly one /api/search call surfaces the content.
    expect(searchStub.search).toHaveBeenCalledTimes(1);
  });

  it('fetches page 1 when the sentinel intersects and extends the right month group', async () => {
    searchStub.pages = [
      {
        total: 2,
        page: 0,
        limit: 200,
        results: [makeResult('a', '/Lib/2026/a.dng', '2026-05-20T00:00:00.000Z')],
      },
      {
        total: 2,
        page: 1,
        limit: 200,
        results: [makeResult('b', '/Lib/2026/b.dng', '2026-05-10T00:00:00.000Z')],
      },
    ];
    library.selectedSourceId.set('lib:');
    const fixture = TestBed.createComponent(TimelineViewComponent);
    fixture.detectChanges();
    await new Promise((r) => setTimeout(r, 300));
    fixture.detectChanges();
    await new Promise((r) => setTimeout(r, 0));
    fixture.detectChanges();
    expect(searchStub.search).toHaveBeenCalledTimes(1);

    const sentinelEl = ioObservedTargets.find((el) => !el.dataset['year']);
    expect(sentinelEl).toBeDefined();
    const sentinelCallback = ioCalls[1]!.callbacks;
    sentinelCallback(
      [{ isIntersecting: true, target: sentinelEl! } as unknown as IntersectionObserverEntry],
      {} as IntersectionObserver,
    );
    await new Promise((r) => setTimeout(r, 0));
    fixture.detectChanges();

    expect(searchStub.search).toHaveBeenCalledTimes(2);
    expect(searchStub.searchCalls[1]!.page).toBe(1);
    const html = fixture.nativeElement.textContent as string;
    expect(html).toContain('2 photos');
  });

  it('retries the same page on error without reloading everything', async () => {
    let calls = 0;
    searchStub.search = vi.fn((p: SearchParams) => {
      searchStub.searchCalls.push(p);
      calls++;
      if (calls === 1) throw new Error('network down');
      return of({
        total: 1,
        page: 0,
        limit: 200,
        results: [makeResult('a', '/Lib/2026/a.dng', '2026-05-20T00:00:00.000Z')],
      });
    });
    library.selectedSourceId.set('lib:');
    const fixture = TestBed.createComponent(TimelineViewComponent);
    fixture.detectChanges();
    await new Promise((r) => setTimeout(r, 300));
    fixture.detectChanges();
    expect(fixture.nativeElement.textContent).toContain('network down');

    fixture.componentInstance.retryPage();
    await new Promise((r) => setTimeout(r, 0));
    fixture.detectChanges();

    expect(searchStub.searchCalls).toHaveLength(2);
    expect(searchStub.searchCalls[1]!.page).toBe(0);
    expect(fixture.nativeElement.textContent).toContain('2026');
  });

  it('keeps already-loaded months on screen when a later page fails', async () => {
    let calls = 0;
    searchStub.search = vi.fn((p: SearchParams) => {
      searchStub.searchCalls.push(p);
      calls++;
      if (calls === 1) {
        return of({
          total: 2,
          page: 0,
          limit: 200,
          results: [makeResult('a', '/Lib/2026/a.dng', '2026-05-20T00:00:00.000Z')],
        });
      }
      throw new Error('network down');
    });
    library.selectedSourceId.set('lib:');
    const fixture = TestBed.createComponent(TimelineViewComponent);
    fixture.detectChanges();
    await new Promise((r) => setTimeout(r, 300));
    fixture.detectChanges();
    await new Promise((r) => setTimeout(r, 0));
    fixture.detectChanges();

    const sentinelEl = ioObservedTargets.find((el) => !el.dataset['year']);
    const sentinelCallback = ioCalls[1]!.callbacks;
    sentinelCallback(
      [{ isIntersecting: true, target: sentinelEl! } as unknown as IntersectionObserverEntry],
      {} as IntersectionObserver,
    );
    await new Promise((r) => setTimeout(r, 0));
    fixture.detectChanges();

    const html = fixture.nativeElement.textContent as string;
    // Page 0's month is still rendered — a page-1 failure must not wipe it.
    expect(html).toContain('2026');
    expect(html).toContain('network down');
  });

  it('dedupes concurrent thumb requests for the same photo', async () => {
    library.selectedSourceId.set('lib:');
    const fixture = TestBed.createComponent(TimelineViewComponent);
    fixture.detectChanges();

    let resolveThumb!: (url: string) => void;
    const fsBrowse = TestBed.inject(FilesystemBrowseService) as unknown as FsBrowseStub;
    fsBrowse.getThumbBlobUrl = vi.fn(
      () =>
        new Promise<string>((resolve) => {
          resolveThumb = resolve;
        }),
    );

    const photo = { ...makeResult('a', '/Lib/2026/a.dng', '2026-05-20T00:00:00.000Z') };
    // Simulates the real race: _fetchPage's own thumb-load loop and the
    // visibility observer's "newly visible" loop can both call _loadThumb
    // for the same photo before the first request resolves.
    const comp = fixture.componentInstance as unknown as {
      _loadThumb(p: typeof photo & { thumbUrl: string | null }, monthKey: string): Promise<void>;
    };
    const p1 = comp._loadThumb({ ...photo, thumbUrl: null }, '2026-5');
    const p2 = comp._loadThumb({ ...photo, thumbUrl: null }, '2026-5');
    resolveThumb('blob:one');
    await p1;
    await p2;

    expect(fsBrowse.getThumbBlobUrl).toHaveBeenCalledTimes(1);
  });

  // The regression that motivated #2219: a full page used to issue one thumb
  // request per row all at once. Against the HTTP/1.1 Self Hosted API that
  // saturated the browser's 6-connection budget and starved every other
  // /api/* call. Asserted at the component (not just the queue) because the
  // defect was in how `_fetchPage` drove the loader, not in the loader.
  it('bounds in-flight thumb requests for a full 200-row page', async () => {
    let live = 0;
    let peak = 0;
    const settle: Array<() => void> = [];
    const fsBrowse = TestBed.inject(FilesystemBrowseService) as unknown as FsBrowseStub;
    fsBrowse.getThumbBlobUrl = vi.fn(() => {
      live++;
      peak = Math.max(peak, live);
      return new Promise<string>((resolve) => {
        settle.push(() => {
          live--;
          resolve('blob:fake');
        });
      });
    });

    searchStub.pages = [
      {
        total: 200,
        page: 0,
        limit: 200,
        results: Array.from({ length: 200 }, (_, i) =>
          makeResult(`a${i}`, `/Lib/2026/a${i}.dng`, '2026-05-20T00:00:00.000Z'),
        ),
      },
    ];
    library.selectedSourceId.set('lib:');
    const fixture = TestBed.createComponent(TimelineViewComponent);
    fixture.detectChanges();
    await new Promise((r) => setTimeout(r, 300));
    fixture.detectChanges();

    expect(peak).toBe(MAX_CONCURRENT_THUMB_LOADS);

    // And the queue keeps draining as requests settle — a bound, not a cap
    // that silently drops the rest of the page.
    for (let round = 0; round < 5; round++) {
      for (const done of settle.splice(0, settle.length)) done();
      await new Promise((r) => setTimeout(r, 0));
    }
    expect(fsBrowse.getThumbBlobUrl.mock.calls.length).toBeGreaterThan(MAX_CONCURRENT_THUMB_LOADS);
    expect(peak).toBe(MAX_CONCURRENT_THUMB_LOADS);
  });

  it('wires both observers against the live #scrollContainer, not a stale ref', async () => {
    searchStub.pages = [
      {
        total: 1,
        page: 0,
        limit: 200,
        results: [makeResult('a', '/Lib/2026/a.dng', '2026-05-20T00:00:00.000Z')],
      },
    ];
    library.selectedSourceId.set('lib:');
    const fixture = TestBed.createComponent(TimelineViewComponent);
    fixture.detectChanges();
    await new Promise((r) => setTimeout(r, 300));
    fixture.detectChanges();
    await new Promise((r) => setTimeout(r, 0));
    fixture.detectChanges();

    expect(ioCalls.length).toBeGreaterThanOrEqual(2);
    const liveRoot = fixture.nativeElement.querySelector('.timeline-scroll') as HTMLElement;
    expect(liveRoot).not.toBeNull();
    for (const call of ioCalls) {
      expect(call.root).toBe(liveRoot);
    }
    const monthTargets = ioObservedTargets.filter((el) => el.dataset['year']);
    expect(monthTargets.length).toBeGreaterThanOrEqual(1);
    for (const el of monthTargets) {
      expect(liveRoot.contains(el)).toBe(true);
    }
  });

  it('resets and refetches page 0 when a filter signal changes (debounced)', async () => {
    searchStub.pages = [
      {
        total: 1,
        page: 0,
        limit: 200,
        results: [makeResult('a', '/Lib/2026/a.dng', '2026-05-20T00:00:00.000Z')],
      },
    ];
    library.selectedSourceId.set('lib:');
    const fixture = TestBed.createComponent(TimelineViewComponent);
    fixture.detectChanges();
    await new Promise((r) => setTimeout(r, 300));
    expect(searchStub.search).toHaveBeenCalledTimes(1);

    timeline.setMinRating(4);
    fixture.detectChanges();
    await new Promise((r) => setTimeout(r, 300));
    expect(searchStub.search).toHaveBeenCalledTimes(2);
    const last = searchStub.searchCalls[1]!;
    expect(last.rating).toBe(4);
    expect(last.page).toBe(0);
  });
});
