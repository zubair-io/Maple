// PhotoResultsSectionComponent — 3-column preview grid for S7 (#622).
//
// Spec: docs/design/responsive-program/s7-search.md §2.
//
// Eyebrow line: "PHOTOS · {count}". Grid: all results, 3-col, square crop.
// Tap a tile → host pushes to Editor (S5). Infinite scroll via an
// IntersectionObserver on a sentinel element below the grid — emits
// `loadMore` when the sentinel enters the viewport.
//
// Stale state: dimming the grid to 60% is driven by the `isStale` input —
// the host flips it while a debounced fetch is in flight so the user gets
// continuity instead of a spinner.

import {
  AfterViewInit,
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  OnDestroy,
  ViewChild,
  input,
  output,
} from '@angular/core';
import { SearchResult } from '../api/search.service';

@Component({
  selector: 'app-photo-results-section',
  standalone: true,
  templateUrl: './photo-results-section.component.html',
  styleUrl: './photo-results-section.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class PhotoResultsSectionComponent implements AfterViewInit, OnDestroy {
  /** Full result list — rendered in their entirety (no slice cap). */
  readonly results = input<readonly SearchResult[]>([]);
  /** Total result count for the eyebrow (may exceed `results.length`). */
  readonly total = input<number>(0);
  /** When true the grid dims to 60% (debounced fetch in flight). */
  readonly isStale = input<boolean>(false);
  /** When true and `results.length === 0`, render the empty-results
   * message instead of the grid. */
  readonly hasQuery = input<boolean>(false);
  /** Query string echoed in the empty-results message. */
  readonly query = input<string>('');
  /** When true, renders a loading indicator below the grid. */
  readonly isLoadingMore = input<boolean>(false);

  /** Tile-click emits the underlying result so the host can navigate. */
  readonly resultTap = output<SearchResult>();
  /** Emitted when the infinite-scroll sentinel intersects the viewport. */
  readonly loadMore = output<void>();

  @ViewChild('loadMoreSentinel') private sentinelRef?: ElementRef<HTMLElement>;

  private observer: IntersectionObserver | null = null;

  ngAfterViewInit(): void {
    // Guard for SSR / vitest jsdom (IntersectionObserver is not available there).
    if (typeof IntersectionObserver === 'undefined') return;
    const el = this.sentinelRef?.nativeElement;
    if (!el) return;
    this.observer = new IntersectionObserver(
      (entries) => {
        if (entries[0]?.isIntersecting) {
          this.loadMore.emit();
        }
      },
      { rootMargin: '200px' },
    );
    this.observer.observe(el);
  }

  ngOnDestroy(): void {
    this.observer?.disconnect();
    this.observer = null;
  }

  protected onTileClick(r: SearchResult): void {
    this.resultTap.emit(r);
  }

  protected trackResult = (_: number, r: SearchResult) => r.id;
}
