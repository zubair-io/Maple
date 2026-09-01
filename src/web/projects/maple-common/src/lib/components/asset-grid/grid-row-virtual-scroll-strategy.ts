// Variable-height counterpart to CDK's `FixedSizeVirtualScrollStrategy`
// (#3103). `cdk-virtual-scroll-viewport[itemSize]` assumes every rendered
// item is the same height — the grid's rows never were: justified image
// rows range from `max(40, …)` up to `thumbSize * 1.4`, and the folder
// section (#3099) adds its own fixed 64px rows with 4px/12px spacing on
// top. Driving the viewport with `itemSize="thumbSize * 1.2"` as an
// average made the scrollbar extent and the offset→index mapping only
// approximate — invisible at the 600–900px buffers this grid uses, but
// wrong.
//
// `AssetGridComponent.gridRows()` already computes every row's exact
// height up front (it has to, to lay the row out), so an exact strategy
// costs nothing extra: `setRowSizes` turns those heights into a prefix-sum
// offset table once per `gridRows()` recompute, and every subsequent
// scroll/render pass is an O(log n) binary search into that table instead
// of the fixed strategy's O(1) division. The buffer/expand algorithm below
// is otherwise a direct port of `FixedSizeVirtualScrollStrategy`'s
// `_updateRenderedRange` (`@angular/cdk/scrolling`), substituting the
// division-based offset↔index conversions for lookups into the table.

import { Injectable } from '@angular/core';
import { Subject } from 'rxjs';
import { distinctUntilChanged } from 'rxjs/operators';
import type { ListRange } from '@angular/cdk/collections';
import type { CdkVirtualScrollViewport, VirtualScrollStrategy } from '@angular/cdk/scrolling';

/** The grid's buffer sizes — unchanged from the `minBufferPx`/`maxBufferPx`
 * the old `[itemSize]` template attributes carried (#3103 keeps them). This
 * strategy is purpose-built for `AssetGridComponent`, not a general-purpose
 * directive, so the buffers live here as constants rather than as
 * constructor/input configuration nothing in this codebase needs yet. */
const MIN_BUFFER_PX = 600;
const MAX_BUFFER_PX = 900;

@Injectable()
export class GridRowVirtualScrollStrategy implements VirtualScrollStrategy {
  private readonly _scrolledIndexChange = new Subject<number>();
  readonly scrolledIndexChange = this._scrolledIndexChange.pipe(distinctUntilChanged());

  private viewport: CdkVirtualScrollViewport | null = null;

  /** Prefix-sum offsets: `offsets[i]` is row `i`'s start offset (px) from
   * the top of the content; `offsets[length]` (one past the last row) is
   * the total content size. `[0]` (no rows) is the empty-grid default. */
  private offsets: readonly number[] = [0];

  /** Feed the strategy each row's exact vertical footprint — height plus
   * the margin-bottom spacing the template renders below it — in order.
   * Called from `AssetGridComponent` on every `gridRows()` recompute
   * (thumb size change, filter/sort change, folder count change, …). */
  setRowSizes(sizes: readonly number[]): void {
    const offsets = new Array<number>(sizes.length + 1);
    offsets[0] = 0;
    for (let i = 0; i < sizes.length; i++) offsets[i + 1] = offsets[i] + sizes[i];
    this.offsets = offsets;
    this._updateTotalContentSize();
    this._updateRenderedRange();
  }

  attach(viewport: CdkVirtualScrollViewport): void {
    this.viewport = viewport;
    this._updateTotalContentSize();
    this._updateRenderedRange();
  }

  detach(): void {
    this._scrolledIndexChange.complete();
    this.viewport = null;
  }

  onContentScrolled(): void {
    this._updateRenderedRange();
  }

  onDataLengthChanged(): void {
    // The data length the viewport knows about only moves in step with
    // `setRowSizes` (both are driven by the same `gridRows()` computed
    // signal), so there's nothing extra to reconcile here — but the
    // interface contract still requires a range refresh on this hook.
    this._updateRenderedRange();
  }

  // Required no-op hooks on the `VirtualScrollStrategy` interface — the
  // viewport calls these polymorphically (not by name from our code), so
  // fallow's static call-graph analysis can't see the use.
  // fallow-ignore-next-line unused-class-member
  onContentRendered(): void {}
  // fallow-ignore-next-line unused-class-member
  onRenderedOffsetChanged(): void {}

  scrollToIndex(index: number, behavior: ScrollBehavior): void {
    if (!this.viewport) return;
    const dataLength = this.offsets.length - 1;
    const clamped = Math.max(0, Math.min(index, dataLength - 1));
    this.viewport.scrollToOffset(this.offsets[clamped] ?? 0, behavior);
  }

  /** Binary search: the greatest row index `i` with `offsets[i] <= offset`,
   * clamped to the last real row (`dataLength - 1`). O(log n) — the whole
   * point of precomputing the prefix sum rather than scanning it. */
  private indexForOffset(offset: number): number {
    const offsets = this.offsets;
    const dataLength = offsets.length - 1;
    if (dataLength <= 0) return 0;
    let lo = 0;
    let hi = dataLength - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (offsets[mid] <= offset) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  }

  private _updateTotalContentSize(): void {
    this.viewport?.setTotalContentSize(this.offsets[this.offsets.length - 1] ?? 0);
  }

  // fallow-ignore-next-line complexity
  private _updateRenderedRange(): void {
    const viewport = this.viewport;
    if (!viewport) return;
    const offsets = this.offsets;
    const dataLength = offsets.length - 1;

    if (dataLength <= 0) {
      viewport.setRenderedRange({ start: 0, end: 0 });
      viewport.setRenderedContentOffset(0);
      this._scrolledIndexChange.next(0);
      return;
    }

    const renderedRange = viewport.getRenderedRange();
    const newRange: ListRange = { start: renderedRange.start, end: renderedRange.end };
    const viewportSize = viewport.getViewportSize();
    let scrollOffset = viewport.measureScrollOffset();
    let firstVisibleIndex = this.indexForOffset(scrollOffset);

    // Data shrank while scrolled near the old end (e.g. a filter narrowed
    // the grid) — pull the range back to whatever now fits in the tail.
    if (newRange.end > dataLength) {
      const total = offsets[dataLength];
      const clampedOffset = Math.max(0, Math.min(scrollOffset, Math.max(0, total - viewportSize)));
      if (clampedOffset !== scrollOffset) {
        scrollOffset = clampedOffset;
        firstVisibleIndex = this.indexForOffset(scrollOffset);
        newRange.start = firstVisibleIndex;
      }
      newRange.end = dataLength;
    }

    const startBuffer = scrollOffset - offsets[newRange.start];
    if (startBuffer < MIN_BUFFER_PX && newRange.start !== 0) {
      newRange.start = this.indexForOffset(Math.max(0, scrollOffset - MAX_BUFFER_PX));
      newRange.end = Math.min(
        dataLength,
        this.indexForOffset(scrollOffset + viewportSize + MIN_BUFFER_PX) + 1,
      );
    } else {
      const endOffset = offsets[newRange.end] ?? offsets[dataLength];
      const endBuffer = endOffset - (scrollOffset + viewportSize);
      if (endBuffer < MIN_BUFFER_PX && newRange.end !== dataLength) {
        newRange.end = Math.min(
          dataLength,
          this.indexForOffset(scrollOffset + viewportSize + MAX_BUFFER_PX) + 1,
        );
        newRange.start = this.indexForOffset(Math.max(0, scrollOffset - MIN_BUFFER_PX));
      }
    }

    viewport.setRenderedRange(newRange);
    viewport.setRenderedContentOffset(offsets[newRange.start] ?? 0);
    this._scrolledIndexChange.next(firstVisibleIndex);
  }
}
