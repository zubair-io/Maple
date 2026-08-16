// PeopleGridController — virtual-scroll grid geometry for the People and
// Hidden People pages.
//
// Both pages render the same card grid inside a
// `cdk-virtual-scroll-viewport`, which virtualises a flat stream by a fixed
// `itemSize`. So the people are packed into fixed-height rows and the ROWS
// are virtualised; the column count, card side, and row height all derive
// from the measured viewport width. That derivation plus the
// ResizeObserver lifecycle was duplicated verbatim across the two
// components (#2901) — it lives here now, and each page keeps only its own
// row-packing (they pack different lists).
//
// Mirrors the `ThumbBlobCache` / `PeopleBulkController` pattern: a plain
// class instantiated once per component instance. Signals and computeds
// work outside an injection context; `effect()` does not, so the host
// component owns the one-line effect that feeds `observe()` and calls
// `disconnect()` on cleanup.

import { computed, signal } from '@angular/core';
import { PEOPLE_GRID, peopleCardWidth, peopleGridColumns, peopleRowHeight } from './people.vm';

/** Width assumed until the ResizeObserver reports the real one. */
const SEED_WIDTH = 900;

/** Below this viewport width the cards go denser, matching the old
 * responsive `minmax(140px|180px, 1fr)` CSS. */
const PHONE_MAX_WIDTH = 767;

export class PeopleGridController {
  /** Measured inner width of the viewport. */
  private readonly containerWidth = signal<number>(SEED_WIDTH);

  private readonly minCardWidth = computed(() =>
    this.containerWidth() <= PHONE_MAX_WIDTH ? 140 : 180,
  );

  readonly columns = computed(() => peopleGridColumns(this.containerWidth(), this.minCardWidth()));

  /** Square card side (px) for the current column count + container width. */
  readonly cardWidth = computed(() => peopleCardWidth(this.containerWidth(), this.columns()));

  /** Fixed row height fed to the viewport `itemSize`. */
  readonly rowHeight = computed(() => peopleRowHeight(this.cardWidth()));

  /** Inter-card gap + per-row bottom margin (px). One source of truth shared
   * with the packing math (`peopleRowHeight` adds one `GAP`/row). */
  readonly gap = PEOPLE_GRID.GAP;

  private resizeObserver?: ResizeObserver;

  /** (Re)attach to the current viewport host and seed the width immediately.
   *
   * Takes the element rather than the signal query so the caller's effect
   * stays the thing that tracks it. `undefined` is expected and ignored: the
   * viewport lives in conditional template blocks, so the query can hold a
   * stale ElementRef whose `nativeElement` is gone right after an `@if` swap
   * — reading `clientWidth` off that used to crash every change-detection
   * pass (#2080/#2081).
   */
  observe(host: HTMLElement | undefined): void {
    if (!host) return;
    this.containerWidth.set(host.clientWidth || SEED_WIDTH);
    if (typeof ResizeObserver === 'undefined') return; // SSR / very old browser
    this.resizeObserver?.disconnect();
    this.resizeObserver = new ResizeObserver((entries) => {
      for (const e of entries) this.containerWidth.set(e.contentRect.width);
    });
    this.resizeObserver.observe(host);
  }

  /** Stop observing — the host's effect cleanup (the viewport went away) and
   * its `ngOnDestroy` both call this. */
  disconnect(): void {
    this.resizeObserver?.disconnect();
    this.resizeObserver = undefined;
  }
}
