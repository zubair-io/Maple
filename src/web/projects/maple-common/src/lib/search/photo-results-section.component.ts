// PhotoResultsSectionComponent — 3-column preview grid for S7 (#622).
//
// Spec: docs/design/responsive-program/s7-search.md §2.
//
// Eyebrow line: "PHOTOS · {count}" with a trailing "See all" link.
// Grid: up to 9 tiles, 3-col, square crop. Tap a tile → host pushes to
// Editor (S5). Tap "See all" → host pushes to the filtered full grid.
//
// Stale state: dimming the grid to 60% is driven by the `isStale` input —
// the host flips it while a debounced fetch is in flight so the user gets
// continuity instead of a spinner.

import { ChangeDetectionStrategy, Component, computed, input, output } from '@angular/core';
import { SearchResult } from '../api/search.service';

@Component({
  selector: 'app-photo-results-section',
  standalone: true,
  templateUrl: './photo-results-section.component.html',
  styleUrl: './photo-results-section.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class PhotoResultsSectionComponent {
  /** Full result list — only the first 9 render in the preview grid. */
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

  /** Tile-click emits the underlying result so the host can navigate. */
  readonly resultTap = output<SearchResult>();
  /** "See all" click. */
  readonly seeAll = output<void>();

  protected readonly tiles = computed(() => this.results().slice(0, 9));

  protected onTileClick(r: SearchResult): void {
    this.resultTap.emit(r);
  }

  protected onSeeAllClick(): void {
    this.seeAll.emit();
  }

  protected trackResult = (_: number, r: SearchResult) => r.id;
}
