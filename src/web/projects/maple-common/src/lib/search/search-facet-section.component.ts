// SearchFacetSectionComponent — one People/Places section of the unified
// Filters panel (#2865): eyebrow title, empty-state line, and the
// multi-select rows (avatar/icon, name, count, checkmark). The panel
// renders it twice (people, places); keeping the row rendering here keeps
// the panel template's branching inside the complexity gate and the row
// styles in one place (`_option-rows.scss`).

import { ChangeDetectionStrategy, Component, input, output } from '@angular/core';

export interface FacetRow {
  readonly value: string;
  readonly count: number;
  readonly selected: boolean;
}

@Component({
  selector: 'app-search-facet-section',
  standalone: true,
  templateUrl: './search-facet-section.component.html',
  styleUrl: './search-facet-section.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class SearchFacetSectionComponent {
  readonly title = input.required<string>();
  /** Icon + testid flavour: person rows show an initial avatar, place
   * rows the location glyph. Also prefixes the row testids
   * (`filter-person-…` / `filter-place-…`). */
  readonly kind = input.required<'person' | 'place'>();
  readonly rows = input<readonly FacetRow[]>([]);
  readonly emptyLabel = input<string>('None yet');

  readonly rowToggle = output<string>();

  protected initial(name: string): string {
    return name.trim().charAt(0).toUpperCase();
  }
}
