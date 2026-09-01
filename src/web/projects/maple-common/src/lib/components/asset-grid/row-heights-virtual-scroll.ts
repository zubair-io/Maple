// Row-heights virtual scroll strategy for `app-asset-grid` (#3103).
//
// The grid's rows have never been one size — justified image rows run from
// 40px up to `thumbSize * 1.4`, and the folder section (#3099) adds 64px
// rows with their own spacing — but the viewport was driven by CDK's
// FixedSizeVirtualScrollStrategy with a single `itemSize` estimate, so the
// scrollbar extent and the scroll-offset → row mapping were approximate.
// `gridRows()` already knows every row's height up front, so this strategy
// works from the exact cumulative offsets instead of an estimate: total
// content size is the real sum, the rendered range is found by binary
// search, and the rendered content offset is the true top of the first
// rendered row. Each height passed in is the row's full box (height +
// spacing below), so the template must keep spacing inside the row box.

import { Directive, forwardRef, input, effect } from '@angular/core';
import {
  CdkVirtualScrollViewport,
  VIRTUAL_SCROLL_STRATEGY,
  VirtualScrollStrategy,
} from '@angular/cdk/scrolling';
import { Observable, Subject, distinctUntilChanged } from 'rxjs';

/** Exact-offset virtual scroll over rows whose heights are known ahead of
 * rendering. Pure TypeScript apart from the CDK viewport contract, so it is
 * unit-tested against a fake viewport. */
export class RowHeightsVirtualScrollStrategy implements VirtualScrollStrategy {
  private readonly scrolledIndex$ = new Subject<number>();
  readonly scrolledIndexChange: Observable<number> =
    this.scrolledIndex$.pipe(distinctUntilChanged());

  private viewport: CdkVirtualScrollViewport | null = null;
  /** `offsets[i]` is the top of row `i`; `offsets[length]` is the total height. */
  private offsets: number[] = [0];

  constructor(
    heights: readonly number[],
    private minBufferPx: number,
    private maxBufferPx: number,
  ) {
    this.offsets = cumulativeOffsets(heights);
  }

  attach(viewport: CdkVirtualScrollViewport): void {
    this.viewport = viewport;
    this.updateTotalContentSize();
    this.updateRenderedRange();
  }

  detach(): void {
    this.scrolledIndex$.complete();
    this.viewport = null;
  }

  /** Replace the row heights (rows re-packed, container resized, thumb size
   * changed) and re-derive the content size and rendered range. */
  updateRows(heights: readonly number[], minBufferPx: number, maxBufferPx: number): void {
    this.offsets = cumulativeOffsets(heights);
    this.minBufferPx = minBufferPx;
    this.maxBufferPx = maxBufferPx;
    this.updateTotalContentSize();
    this.updateRenderedRange();
  }

  onContentScrolled(): void {
    this.updateRenderedRange();
  }

  onDataLengthChanged(): void {
    this.updateTotalContentSize();
    this.updateRenderedRange();
  }

  onContentRendered(): void {}

  onRenderedOffsetChanged(): void {}

  scrollToIndex(index: number, behavior: ScrollBehavior): void {
    if (!this.viewport) return;
    const clamped = Math.max(0, Math.min(index, this.rowCount));
    this.viewport.scrollToOffset(this.offsets[clamped], behavior);
  }

  /** Total content height — the real sum of the row boxes. */
  get totalContentSize(): number {
    return this.offsets[this.offsets.length - 1];
  }

  /** Index of the row containing `offset` (clamped into the row range). */
  indexAt(offset: number): number {
    return indexAtOffset(this.offsets, offset);
  }

  private get rowCount(): number {
    return this.offsets.length - 1;
  }

  private updateTotalContentSize(): void {
    this.viewport?.setTotalContentSize(this.totalContentSize);
  }

  private updateRenderedRange(): void {
    const viewport = this.viewport;
    if (!viewport) return;
    const rowCount = this.rowCount;
    if (rowCount === 0) {
      viewport.setRenderedRange({ start: 0, end: 0 });
      viewport.setRenderedContentOffset(0);
      this.scrolledIndex$.next(0);
      return;
    }

    const viewportSize = viewport.getViewportSize();
    const scrollOffset = Math.max(
      0,
      Math.min(viewport.measureScrollOffset(), this.totalContentSize - viewportSize),
    );
    const firstVisible = this.indexAt(scrollOffset);

    // Keep the current range while it still covers the viewport plus the
    // minimum buffer on both sides — re-rendering only when a buffer runs
    // thin is what stops every scroll tick from re-packing the rows.
    const current = viewport.getRenderedRange();
    const currentTop = this.offsets[current.start];
    const currentBottom = this.offsets[current.end];
    const coveredAbove = current.start === 0 || currentTop <= scrollOffset - this.minBufferPx;
    const coveredBelow =
      current.end === rowCount || currentBottom >= scrollOffset + viewportSize + this.minBufferPx;
    const keep =
      current.end > current.start && current.end <= rowCount && coveredAbove && coveredBelow;

    const range = keep
      ? current
      : {
          start: this.indexAt(scrollOffset - this.maxBufferPx),
          end: Math.min(rowCount, this.indexAt(scrollOffset + viewportSize + this.maxBufferPx) + 1),
        };

    viewport.setRenderedRange(range);
    viewport.setRenderedContentOffset(this.offsets[range.start]);
    this.scrolledIndex$.next(firstVisible);
  }
}

/** `[0, h0, h0+h1, …, total]`. */
export function cumulativeOffsets(heights: readonly number[]): number[] {
  const offsets = new Array<number>(heights.length + 1);
  offsets[0] = 0;
  heights.forEach((h, i) => {
    offsets[i + 1] = offsets[i] + Math.max(0, h);
  });
  return offsets;
}

/** Binary search: the largest row index whose top is at or before `offset`,
 * clamped to `[0, rowCount - 1]` (or 0 when there are no rows). */
export function indexAtOffset(offsets: readonly number[], offset: number): number {
  const rowCount = offsets.length - 1;
  if (rowCount <= 0 || offset <= 0) return 0;
  let lo = 0;
  let hi = rowCount - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (offsets[mid] <= offset) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

/**
 * `<cdk-virtual-scroll-viewport [mapleRowHeights]="…">` — drives the viewport
 * from a list of known row box heights (each row's height plus the spacing
 * kept inside its box). Mirrors CDK's own `CdkFixedSizeVirtualScroll`
 * directive shape: the strategy instance is created once and updated in
 * place when the inputs change.
 */
@Directive({
  selector: 'cdk-virtual-scroll-viewport[mapleRowHeights]',
  standalone: true,
  providers: [
    {
      provide: VIRTUAL_SCROLL_STRATEGY,
      useFactory: (dir: RowHeightsVirtualScrollDirective) => dir.strategy,
      deps: [forwardRef(() => RowHeightsVirtualScrollDirective)],
    },
  ],
})
export class RowHeightsVirtualScrollDirective {
  readonly mapleRowHeights = input.required<readonly number[]>();
  readonly minBufferPx = input<number>(600);
  readonly maxBufferPx = input<number>(900);

  readonly strategy = new RowHeightsVirtualScrollStrategy([], 600, 900);

  constructor() {
    effect(() => {
      this.strategy.updateRows(this.mapleRowHeights(), this.minBufferPx(), this.maxBufferPx());
    });
  }
}
