// grid-row-virtual-scroll-strategy.spec.ts (#3103) — exercises the strategy
// directly against a hand-rolled viewport stub rather than a real
// `cdk-virtual-scroll-viewport` DOM render: everything this strategy reads
// or writes is the small `CdkVirtualScrollViewport` surface below, and a
// stub makes every scroll position/buffer-expansion scenario exactly
// reproducible (no real scrollbars, no ResizeObserver, no flakiness).

import { describe, it, expect, beforeEach } from 'vitest';
import type { ListRange } from '@angular/cdk/collections';
import type { CdkVirtualScrollViewport } from '@angular/cdk/scrolling';

import { GridRowVirtualScrollStrategy } from './grid-row-virtual-scroll-strategy';

class MockViewport {
  totalContentSize = 0;
  renderedRange: ListRange = { start: 0, end: 0 };
  renderedContentOffset: number | null = null;
  viewportSize = 500;
  scrollOffset = 0;
  scrollToOffsetCalls: { offset: number; behavior?: ScrollBehavior }[] = [];

  setTotalContentSize(size: number): void {
    this.totalContentSize = size;
  }
  setRenderedRange(range: ListRange): void {
    this.renderedRange = range;
  }
  getRenderedRange(): ListRange {
    return this.renderedRange;
  }
  getViewportSize(): number {
    return this.viewportSize;
  }
  measureScrollOffset(): number {
    return this.scrollOffset;
  }
  setRenderedContentOffset(offset: number): void {
    this.renderedContentOffset = offset;
  }
  scrollToOffset(offset: number, behavior?: ScrollBehavior): void {
    this.scrollToOffsetCalls.push({ offset, behavior });
  }
}

function asViewport(mock: MockViewport): CdkVirtualScrollViewport {
  return mock as unknown as CdkVirtualScrollViewport;
}

describe('GridRowVirtualScrollStrategy', () => {
  let strategy: GridRowVirtualScrollStrategy;
  let viewport: MockViewport;

  beforeEach(() => {
    strategy = new GridRowVirtualScrollStrategy();
    viewport = new MockViewport();
  });

  it('renders an empty range and zero offset for a grid with no rows', () => {
    strategy.setRowSizes([]);
    strategy.attach(asViewport(viewport));

    expect(viewport.totalContentSize).toBe(0);
    expect(viewport.renderedRange).toEqual({ start: 0, end: 0 });
    expect(viewport.renderedContentOffset).toBe(0);
  });

  it('sums row sizes into the total content size', () => {
    // Mirrors real gridRows() footprints: image row height + spacingBelow.
    strategy.setRowSizes([120, 120, 64, 100]);
    strategy.attach(asViewport(viewport));

    expect(viewport.totalContentSize).toBe(404);
  });

  it('renders every row when the whole list plus buffers fits the viewport', () => {
    strategy.setRowSizes([100, 100, 100, 100, 100]); // 500px total
    viewport.viewportSize = 500;
    strategy.attach(asViewport(viewport));

    expect(viewport.renderedRange).toEqual({ start: 0, end: 5 });
    expect(viewport.renderedContentOffset).toBe(0);
  });

  it('renders a bounded window near the top of a long list, expanded to the max buffer', () => {
    strategy.setRowSizes(Array(50).fill(100)); // 5000px total, rows at i*100
    viewport.viewportSize = 500;
    strategy.attach(asViewport(viewport));

    // Expand-to-max-buffer targets end offset ~ viewportSize + maxBufferPx
    // (500 + 900 = 1400) from the scroll position (0) — row 14 starts at
    // 1400, so the window's exclusive end lands one past it.
    expect(viewport.renderedRange).toEqual({ start: 0, end: 15 });
    expect(viewport.renderedContentOffset).toBe(0);
  });

  it('shifts the rendered window when scrolled deep into a long list', () => {
    strategy.setRowSizes(Array(50).fill(100)); // rows at i*100, total 5000px
    viewport.viewportSize = 500;
    strategy.attach(asViewport(viewport)); // initial render: {0, 15}

    viewport.scrollOffset = 3000; // row 30
    strategy.onContentScrolled();

    // minBufferPx=600 before/after the visible viewport, expanded to
    // maxBufferPx=900 when a re-render is needed: start pulls back to
    // offset 2400 (row 24), end reaches out to offset 4400 (row 44, so the
    // exclusive end is 45).
    expect(viewport.renderedRange).toEqual({ start: 24, end: 45 });
    expect(viewport.renderedContentOffset).toBe(2400);
  });

  it('does not re-render when the current range already covers both buffers', () => {
    strategy.setRowSizes(Array(50).fill(100));
    viewport.viewportSize = 500;
    strategy.attach(asViewport(viewport));

    // Seed a wide rendered range with plenty of buffer on both sides of a
    // scroll position in the middle, then scroll a little further — still
    // within the seeded buffer, so the range should not move.
    viewport.renderedRange = { start: 10, end: 40 }; // offsets 1000..4000
    viewport.scrollOffset = 2000;
    strategy.onContentScrolled();

    expect(viewport.renderedRange).toEqual({ start: 10, end: 40 });
  });

  it('pulls a stale range back into bounds when the row count shrinks', () => {
    strategy.setRowSizes(Array(50).fill(100));
    viewport.viewportSize = 500;
    strategy.attach(asViewport(viewport));
    viewport.scrollOffset = 4500; // near the old end
    strategy.onContentScrolled();
    expect(viewport.renderedRange.end).toBeGreaterThan(10); // sanity: was deep

    // A filter narrows the grid to 10 rows (1000px) while still scrolled
    // near the old (now nonexistent) tail.
    strategy.setRowSizes(Array(10).fill(100));

    expect(viewport.renderedRange.end).toBeLessThanOrEqual(10);
    expect(viewport.renderedRange.start).toBeGreaterThanOrEqual(0);
    // Content offset must point at an in-bounds row's actual offset.
    expect(viewport.renderedContentOffset).toBeLessThanOrEqual(1000);
  });

  it('scrollToIndex scrolls to the exact cumulative offset of that row', () => {
    strategy.setRowSizes([120, 64, 64, 200]); // offsets 0, 120, 184, 248
    strategy.attach(asViewport(viewport));

    strategy.scrollToIndex(2, 'smooth');

    expect(viewport.scrollToOffsetCalls).toEqual([{ offset: 184, behavior: 'smooth' }]);
  });

  it('scrollToIndex clamps to the last row for an out-of-range index', () => {
    strategy.setRowSizes([100, 100, 100]); // offsets 0, 100, 200
    strategy.attach(asViewport(viewport));

    strategy.scrollToIndex(99, 'auto');

    expect(viewport.scrollToOffsetCalls).toEqual([{ offset: 200, behavior: 'auto' }]);
  });

  it('completes scrolledIndexChange on detach', () => {
    strategy.attach(asViewport(viewport));
    let completed = false;
    strategy.scrolledIndexChange.subscribe({ complete: () => (completed = true) });

    strategy.detach();

    expect(completed).toBe(true);
  });

  it('is a no-op when setRowSizes is called before any viewport is attached', () => {
    expect(() => strategy.setRowSizes([100, 100])).not.toThrow();
  });

  it('refreshes the rendered range on onDataLengthChanged', () => {
    strategy.setRowSizes(Array(50).fill(100));
    viewport.viewportSize = 500;
    strategy.attach(asViewport(viewport));
    viewport.renderedRange = { start: 0, end: 3 }; // pretend it went stale

    strategy.onDataLengthChanged();

    // Same expand-to-buffers outcome as the initial-attach case, since
    // nothing about the row sizes or scroll position changed.
    expect(viewport.renderedRange).toEqual({ start: 0, end: 15 });
  });
});
