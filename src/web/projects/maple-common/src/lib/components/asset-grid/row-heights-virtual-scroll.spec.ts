// row-heights-virtual-scroll.spec.ts — the exact-offset strategy behind
// `app-asset-grid`'s viewport (#3103), exercised against a fake viewport so
// the geometry is proven without a DOM.

import { describe, expect, it, vi } from 'vitest';
import type { CdkVirtualScrollViewport } from '@angular/cdk/scrolling';

import {
  RowHeightsVirtualScrollStrategy,
  cumulativeOffsets,
  indexAtOffset,
} from './row-heights-virtual-scroll';

function fakeViewport(opts: {
  size: number;
  scroll: number;
  rendered?: { start: number; end: number };
}) {
  let rendered = opts.rendered ?? { start: 0, end: 0 };
  const vp = {
    getViewportSize: () => opts.size,
    measureScrollOffset: () => opts.scroll,
    getRenderedRange: () => rendered,
    getDataLength: () => 0,
    setRenderedRange: vi.fn((r: { start: number; end: number }) => (rendered = r)),
    setTotalContentSize: vi.fn(),
    setRenderedContentOffset: vi.fn(),
    scrollToOffset: vi.fn(),
  };
  return vp as unknown as CdkVirtualScrollViewport & typeof vp;
}

// Folder section (64 + 4, 64 + 12) followed by justified rows of 200 + 3.
// Row tops: 0, 68, 144, 347, 550, 753, 956, 1159, 1362, 1565; total 1768.
const HEIGHTS = [68, 76, 203, 203, 203, 203, 203, 203, 203, 203];

describe('cumulativeOffsets / indexAtOffset', () => {
  it('builds the prefix sums with the total in the last slot', () => {
    expect(cumulativeOffsets([68, 76, 203])).toEqual([0, 68, 144, 347]);
    expect(cumulativeOffsets([])).toEqual([0]);
  });

  it('maps an offset to the row whose top is at or before it', () => {
    const offsets = cumulativeOffsets(HEIGHTS);
    expect(indexAtOffset(offsets, 0)).toBe(0);
    expect(indexAtOffset(offsets, 67)).toBe(0);
    expect(indexAtOffset(offsets, 68)).toBe(1);
    expect(indexAtOffset(offsets, 144)).toBe(2);
    expect(indexAtOffset(offsets, 400)).toBe(3);
    // Past the end clamps to the last row; negative clamps to the first.
    expect(indexAtOffset(offsets, 99_999)).toBe(HEIGHTS.length - 1);
    expect(indexAtOffset(offsets, -50)).toBe(0);
    expect(indexAtOffset([0], 10)).toBe(0);
  });
});

describe('RowHeightsVirtualScrollStrategy', () => {
  it('reports the real total content size, not an itemSize estimate', () => {
    const vp = fakeViewport({ size: 600, scroll: 0 });
    const strategy = new RowHeightsVirtualScrollStrategy(HEIGHTS, 100, 200);
    strategy.attach(vp);
    expect(vp.setTotalContentSize).toHaveBeenCalledWith(68 + 76 + 8 * 203);
  });

  it('renders the visible rows plus the max buffer on first attach, offset at the first row top', () => {
    const vp = fakeViewport({ size: 600, scroll: 0 });
    const strategy = new RowHeightsVirtualScrollStrategy(HEIGHTS, 100, 200);
    strategy.attach(vp);
    // Visible: rows 0..4 (tops 0…550); the 200px buffer below 600 reaches
    // offset 800 → row 5 (top 753), so the exclusive end is 6.
    expect(vp.setRenderedRange).toHaveBeenLastCalledWith({ start: 0, end: 6 });
    expect(vp.setRenderedContentOffset).toHaveBeenLastCalledWith(0);
  });

  it('places the rendered content at the exact top of the first rendered row when scrolled', () => {
    const vp = fakeViewport({ size: 600, scroll: 1000 });
    const strategy = new RowHeightsVirtualScrollStrategy(HEIGHTS, 100, 200);
    strategy.attach(vp);
    const range = vp.setRenderedRange.mock.lastCall![0] as { start: number; end: number };
    // 1000 - 200 = 800 → row 5 (top 753).
    expect(range.start).toBe(5);
    expect(vp.setRenderedContentOffset).toHaveBeenLastCalledWith(753);
    // 1000 + 600 + 200 = 1800 is past the end → clamps to the last row → end 10.
    expect(range.end).toBe(10);
  });

  it('keeps the current range while both buffers are still covered', () => {
    const vp = fakeViewport({ size: 600, scroll: 1000, rendered: { start: 3, end: 10 } });
    const strategy = new RowHeightsVirtualScrollStrategy(HEIGHTS, 100, 200);
    strategy.attach(vp);
    // Row 3 top = 347 ≤ 1000 - 100 and end === rowCount → nothing to do.
    expect(vp.setRenderedRange).toHaveBeenLastCalledWith({ start: 3, end: 10 });
    expect(vp.setRenderedContentOffset).toHaveBeenLastCalledWith(347);
  });

  it('re-renders when the buffer above runs thinner than minBufferPx', () => {
    const vp = fakeViewport({ size: 600, scroll: 1000, rendered: { start: 6, end: 10 } });
    const strategy = new RowHeightsVirtualScrollStrategy(HEIGHTS, 100, 200);
    strategy.attach(vp);
    // Row 6 top = 956 > 1000 - 100 → repack from the max buffer: 800 → row 5.
    expect(vp.setRenderedRange).toHaveBeenLastCalledWith({ start: 5, end: 10 });
    expect(vp.setRenderedContentOffset).toHaveBeenLastCalledWith(753);
  });

  it('emits the first visible row index and scrolls to a row by its real offset', () => {
    const vp = fakeViewport({ size: 600, scroll: 400 });
    const strategy = new RowHeightsVirtualScrollStrategy(HEIGHTS, 100, 200);
    const seen: number[] = [];
    strategy.scrolledIndexChange.subscribe((i) => seen.push(i));
    strategy.attach(vp);
    expect(seen).toEqual([3]);
    strategy.scrollToIndex(2, 'auto');
    expect(vp.scrollToOffset).toHaveBeenCalledWith(144, 'auto');
    strategy.scrollToIndex(99, 'smooth');
    expect(vp.scrollToOffset).toHaveBeenLastCalledWith(strategy.totalContentSize, 'smooth');
  });

  it('collapses to an empty range with no rows, and recovers when rows arrive', () => {
    const vp = fakeViewport({ size: 600, scroll: 0 });
    const strategy = new RowHeightsVirtualScrollStrategy([], 100, 200);
    strategy.attach(vp);
    expect(vp.setTotalContentSize).toHaveBeenLastCalledWith(0);
    expect(vp.setRenderedRange).toHaveBeenLastCalledWith({ start: 0, end: 0 });

    strategy.updateRows(HEIGHTS, 100, 200);
    expect(vp.setTotalContentSize).toHaveBeenLastCalledWith(strategy.totalContentSize);
    expect(vp.setRenderedRange).toHaveBeenLastCalledWith({ start: 0, end: 6 });
  });
});
