// PhotoResultsSectionComponent — the unified-search result grid (#2865).
//
// Responsive square-tile grid (auto-fill columns); the result count lives
// in the host's meta row, not here. Tap a tile → host navigates. Infinite
// scroll via an IntersectionObserver on a sentinel element below the grid
// — emits `loadMore` when the sentinel enters the viewport.
//
// Thumbnails arrive via the `thumbs` map (id → blob URL) the host loads
// and caches; a tile renders the placeholder glyph until its URL lands.
//
// Stale state: dimming the grid to 60% is driven by the `isStale` input —
// the host flips it while a debounced fetch is in flight so the user gets
// continuity instead of a spinner.

import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  effect,
  input,
  output,
  viewChild,
} from '@angular/core';
import { SearchResult } from '../api/search.service';
import { MapleIconComponent } from '../icons/maple-icon.component';

@Component({
  selector: 'app-photo-results-section',
  standalone: true,
  imports: [MapleIconComponent],
  templateUrl: './photo-results-section.component.html',
  host: { class: 'block' },
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class PhotoResultsSectionComponent {
  /** Full result list — rendered in their entirety (no slice cap). */
  readonly results = input<readonly SearchResult[]>([]);
  /** Result-id → blob URL. Tiles without an entry keep the placeholder. */
  readonly thumbs = input<ReadonlyMap<string, string>>(new Map<string, string>());
  /** When true the grid dims to 60% (debounced fetch in flight). */
  readonly isStale = input<boolean>(false);
  /** True once a search has completed — with `results.length === 0` it
   * renders the empty-results message instead of the grid. (A filters-only
   * search has no query text, so the name is historical.) */
  readonly hasQuery = input<boolean>(false);
  /** Query string echoed in the empty-results message (may be empty for
   * filters-only searches — the message drops the quote then). */
  readonly query = input<string>('');
  /** When true, renders a loading indicator below the grid. */
  readonly isLoadingMore = input<boolean>(false);
  /** When true, server has more results to load; renders the scroll sentinel. */
  readonly canLoadMore = input<boolean>(true);

  /** Tile-click emits the underlying result so the host can navigate. */
  readonly resultTap = output<SearchResult>();
  /** Emitted when the infinite-scroll sentinel intersects the viewport. */
  readonly loadMore = output<void>();

  readonly sentinelRef = viewChild<ElementRef<HTMLElement>>('loadMoreSentinel');

  constructor() {
    effect((onCleanup) => {
      const el = this.sentinelRef()?.nativeElement;
      const count = this.results().length;
      const canMore = this.canLoadMore();
      if (!el || count === 0 || !canMore || typeof IntersectionObserver === 'undefined') return;

      const root = el.closest('.overflow-y-auto') ?? null;
      const observer = new IntersectionObserver(
        (entries) => {
          if (entries[0]?.isIntersecting && !this.isLoadingMore()) {
            this.loadMore.emit();
          }
        },
        { root, rootMargin: '200px' },
      );
      observer.observe(el);

      onCleanup(() => {
        observer.disconnect();
      });
    });
  }

  protected onTileClick(r: SearchResult): void {
    this.resultTap.emit(r);
  }

  protected trackResult = (_: number, r: SearchResult) => r.id;
}
