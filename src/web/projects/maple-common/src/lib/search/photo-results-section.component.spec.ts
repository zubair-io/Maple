// PhotoResultsSectionComponent — unit tests for the search results grid (#2865).
//
// Tests that:
// 1. Initially empty results transitioning to populated results successfully
//    binds and observes the #loadMoreSentinel IntersectionObserver.
// 2. An intersecting sentinel emits `loadMore`.
// 3. When `isLoadingMore` is true, `loadMore` is not emitted.
// 4. When `canLoadMore` is false, the sentinel is removed from the DOM.
// 5. Tapping a photo result tile emits `resultTap`.

import { ComponentFixture, TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PhotoResultsSectionComponent } from './photo-results-section.component';
import { SearchResult } from '../api/search.service';

function makeResult(id: string): SearchResult {
  return {
    id: `fs:/path/${id}`,
    address: null,
    _id: id,
    folder_id: 'f1',
    abs_path: `/path/${id}.dng`,
    filename: `${id}.dng`,
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

describe('PhotoResultsSectionComponent', () => {
  let fixture: ComponentFixture<PhotoResultsSectionComponent>;
  let component: PhotoResultsSectionComponent;
  let originalIntersectionObserver: typeof IntersectionObserver | undefined;

  let observedElements: Element[] = [];
  let disconnectedCount = 0;
  let lastObserverCallback: IntersectionObserverCallback | null = null;
  let lastObserverOptions: IntersectionObserverInit | undefined = undefined;

  beforeEach(() => {
    observedElements = [];
    disconnectedCount = 0;
    lastObserverCallback = null;
    lastObserverOptions = undefined;

    originalIntersectionObserver = (
      globalThis as { IntersectionObserver?: typeof IntersectionObserver }
    ).IntersectionObserver;

    class MockIntersectionObserver implements IntersectionObserver {
      readonly root: Element | Document | null = null;
      readonly rootMargin: string = '';
      readonly thresholds: readonly number[] = [];

      constructor(callback: IntersectionObserverCallback, options?: IntersectionObserverInit) {
        lastObserverCallback = callback;
        lastObserverOptions = options;
        if (options?.root) this.root = options.root;
        if (options?.rootMargin) this.rootMargin = options.rootMargin;
      }

      observe(target: Element): void {
        observedElements.push(target);
      }

      unobserve(target: Element): void {
        const idx = observedElements.indexOf(target);
        if (idx >= 0) observedElements.splice(idx, 1);
      }

      disconnect(): void {
        disconnectedCount += 1;
        observedElements = [];
      }

      takeRecords(): IntersectionObserverEntry[] {
        return [];
      }
    }

    (globalThis as { IntersectionObserver?: unknown }).IntersectionObserver =
      MockIntersectionObserver;

    TestBed.configureTestingModule({
      imports: [PhotoResultsSectionComponent],
    });

    fixture = TestBed.createComponent(PhotoResultsSectionComponent);
    component = fixture.componentInstance;
  });

  afterEach(() => {
    (globalThis as { IntersectionObserver?: unknown }).IntersectionObserver =
      originalIntersectionObserver;
  });

  it('renders empty message when hasQuery is true and results are empty', () => {
    fixture.componentRef.setInput('hasQuery', true);
    fixture.componentRef.setInput('query', 'landscape');
    fixture.componentRef.setInput('results', []);
    fixture.detectChanges();

    const empty = fixture.nativeElement.querySelector('[data-testid="search-no-results"]');
    expect(empty?.textContent).toContain('No matches for “landscape”');
    expect(observedElements.length).toBe(0);
  });

  it('observes sentinel when results arrive after empty initial state', () => {
    fixture.componentRef.setInput('hasQuery', false);
    fixture.componentRef.setInput('results', []);
    fixture.detectChanges();

    // Initially no results, so no sentinel is observed
    expect(observedElements.length).toBe(0);

    // Results arrive (page 0)
    const results = [makeResult('1'), makeResult('2')];
    fixture.componentRef.setInput('results', results);
    fixture.detectChanges();

    expect(observedElements.length).toBe(1);
    expect(lastObserverOptions?.rootMargin).toBe('200px');
    expect(fixture.nativeElement.querySelectorAll('[data-testid^="search-tile-"]').length).toBe(2);
  });

  it('emits loadMore when the sentinel intersects', () => {
    const results = [makeResult('1')];
    fixture.componentRef.setInput('results', results);
    fixture.detectChanges();

    const loadMoreSpy = vi.fn();
    component.loadMore.subscribe(loadMoreSpy);

    expect(lastObserverCallback).not.toBeNull();
    lastObserverCallback!(
      [{ isIntersecting: true, target: observedElements[0] } as IntersectionObserverEntry],
      {} as IntersectionObserver,
    );

    expect(loadMoreSpy).toHaveBeenCalledTimes(1);
  });

  it('does not emit loadMore when isLoadingMore is true', () => {
    const results = [makeResult('1')];
    fixture.componentRef.setInput('results', results);
    fixture.componentRef.setInput('isLoadingMore', true);
    fixture.detectChanges();

    const loadMoreSpy = vi.fn();
    component.loadMore.subscribe(loadMoreSpy);

    lastObserverCallback!(
      [{ isIntersecting: true, target: observedElements[0] } as IntersectionObserverEntry],
      {} as IntersectionObserver,
    );

    expect(loadMoreSpy).not.toHaveBeenCalled();
  });

  it('removes the sentinel and disconnects observer when canLoadMore is false', () => {
    const results = [makeResult('1')];
    fixture.componentRef.setInput('results', results);
    fixture.componentRef.setInput('canLoadMore', true);
    fixture.detectChanges();

    expect(observedElements.length).toBe(1);

    // All results loaded
    fixture.componentRef.setInput('canLoadMore', false);
    fixture.detectChanges();

    expect(disconnectedCount).toBeGreaterThan(0);
    expect(fixture.nativeElement.querySelector('[aria-hidden="true"].h-px')).toBeNull();
  });

  it('emits resultTap when a tile is clicked', () => {
    const r = makeResult('photo-123');
    fixture.componentRef.setInput('results', [r]);
    fixture.detectChanges();

    const tapSpy = vi.fn();
    component.resultTap.subscribe(tapSpy);

    const button = fixture.nativeElement.querySelector(
      '[data-testid="search-tile-fs:/path/photo-123"]',
    );
    button.click();

    expect(tapSpy).toHaveBeenCalledWith(r);
  });

  it('renders loading more indicator when isLoadingMore is true', () => {
    const results = [makeResult('1')];
    fixture.componentRef.setInput('results', results);
    fixture.componentRef.setInput('isLoadingMore', true);
    fixture.detectChanges();

    expect(fixture.nativeElement.querySelector('[data-testid="search-loading-more"]')).toBeTruthy();

    fixture.componentRef.setInput('isLoadingMore', false);
    fixture.detectChanges();

    expect(fixture.nativeElement.querySelector('[data-testid="search-loading-more"]')).toBeNull();
  });

  it('uses explicit scrollRoot if provided', () => {
    const customContainer = document.createElement('div');
    fixture.componentRef.setInput('scrollRoot', customContainer);
    fixture.componentRef.setInput('results', [makeResult('1')]);
    fixture.detectChanges();

    expect(observedElements.length).toBe(1);
    expect(lastObserverOptions?.root).toBe(customContainer);
  });
});
