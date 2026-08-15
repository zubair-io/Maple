// SearchFilterPanelComponent — the unified Filters surface (#2865).
//
// One content component for both placements: the host renders it inside a
// right-docked column on desktop and a bottom sheet on phones/tablets —
// only the container differs (see `search.component.scss`), matching the
// design's "same filter model across breakpoints" rule.
//
// Sections: DATE RANGE (preset chips + custom from/to), PEOPLE and PLACES
// (multi-select rows with counts from the facets endpoint). The footer's
// "Show N results" mirrors the facets `total`, which the host keeps
// filter-aware, and doubles as the sheet's close affordance.
//
// Presentational: emits a whole new `SearchFilters` value per interaction
// (`filtersChange`) instead of per-dimension outputs — the host owns state.

import { ChangeDetectionStrategy, Component, computed, input, output } from '@angular/core';
import { SearchFacetSectionComponent } from './search-facet-section.component';
import {
  DATE_PRESETS,
  SearchFilters,
  setCustomRange,
  togglePerson,
  togglePlace,
  togglePreset,
} from './search-filters';

export interface FacetOption {
  readonly value: string;
  readonly count: number;
}

@Component({
  selector: 'app-search-filter-panel',
  standalone: true,
  imports: [SearchFacetSectionComponent],
  templateUrl: './search-filter-panel.component.html',
  styleUrl: './search-filter-panel.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class SearchFilterPanelComponent {
  readonly filters = input.required<SearchFilters>();
  /** Facet rows for the People / Places sections (filter-aware counts). */
  readonly people = input<readonly FacetOption[]>([]);
  readonly places = input<readonly FacetOption[]>([]);
  /** Live result count for the footer button; null while loading. */
  readonly total = input<number | null>(null);
  /** True when the host renders this inside the phone bottom sheet —
   * shows the grab handle + close ✕. */
  readonly asSheet = input<boolean>(false);

  readonly filtersChange = output<SearchFilters>();
  readonly clearAll = output<void>();
  /** Footer "Show N results" / header ✕ — the host closes the sheet. */
  readonly dismiss = output<void>();

  protected readonly presets = DATE_PRESETS;

  protected readonly showLabel = computed(() => {
    const t = this.total();
    if (t === null) return 'Show results';
    return `Show ${t.toLocaleString()} ${t === 1 ? 'result' : 'results'}`;
  });

  /** People rows the panel shows: selected ones surface even when they
   * fell out of the (filter-aware, co-occurrence) facet list, so a chip
   * can always be untoggled from the panel. */
  protected readonly peopleRows = computed(() => this.mergeSelected(this.people(), 'people'));
  protected readonly placeRows = computed(() => this.mergeSelected(this.places(), 'places'));

  private mergeSelected(
    options: readonly FacetOption[],
    key: 'people' | 'places',
  ): Array<FacetOption & { selected: boolean }> {
    const selected = this.filters()[key];
    const known = new Set(options.map((o) => o.value));
    const missing = selected.filter((v) => !known.has(v)).map((v) => ({ value: v, count: 0 }));
    return [...options, ...missing].map((o) => ({
      ...o,
      selected: selected.includes(o.value),
    }));
  }

  protected onPreset(id: (typeof DATE_PRESETS)[number]['id']): void {
    this.filtersChange.emit(togglePreset(this.filters(), id));
  }

  protected onFrom(e: Event): void {
    const v = (e.target as HTMLInputElement).value;
    this.filtersChange.emit(setCustomRange(this.filters(), v || null, this.filters().to));
  }

  protected onTo(e: Event): void {
    const v = (e.target as HTMLInputElement).value;
    this.filtersChange.emit(setCustomRange(this.filters(), this.filters().from, v || null));
  }

  protected onPerson(name: string): void {
    this.filtersChange.emit(togglePerson(this.filters(), name));
  }

  protected onPlace(label: string): void {
    this.filtersChange.emit(togglePlace(this.filters(), label));
  }
}
