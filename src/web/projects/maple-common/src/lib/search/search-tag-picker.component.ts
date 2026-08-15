// SearchTagPickerComponent — the `@` people & places picker (#2865).
//
// Typing `@` in the search bar opens this list; the token after `@`
// narrows it (client-side, case-insensitive substring over the facet
// values the host already holds). Picking a row toggles the matching
// filter and the host strips the token from the query. Placement is the
// host's job: anchored dropdown under the bar on desktop, bottom sheet on
// phones — same content either way (see `search.component.scss`).
//
// The template renders one sectioned loop over a precomputed view model
// (rows carry their own count label), keeping its branching flat.

import { ChangeDetectionStrategy, Component, computed, input, output } from '@angular/core';
import type { FacetOption } from './search-filter-panel.component';

export interface TagPick {
  readonly kind: 'person' | 'place';
  readonly value: string;
}

interface TagRow extends FacetOption {
  readonly selected: boolean;
  readonly countLabel: string;
}

interface TagSection {
  readonly title: string;
  readonly kind: 'person' | 'place';
  readonly rows: TagRow[];
}

@Component({
  selector: 'app-search-tag-picker',
  standalone: true,
  templateUrl: './search-tag-picker.component.html',
  styleUrl: './search-tag-picker.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class SearchTagPickerComponent {
  /** The text typed after `@` — filters both lists. */
  readonly fragment = input<string>('');
  readonly people = input<readonly FacetOption[]>([]);
  readonly places = input<readonly FacetOption[]>([]);
  readonly selectedPeople = input<readonly string[]>([]);
  readonly selectedPlaces = input<readonly string[]>([]);

  readonly pick = output<TagPick>();

  protected readonly sections = computed<TagSection[]>(() =>
    [
      {
        title: 'People',
        kind: 'person' as const,
        rows: filterRows(this.people(), this.fragment(), this.selectedPeople()),
      },
      {
        title: 'Places',
        kind: 'place' as const,
        rows: filterRows(this.places(), this.fragment(), this.selectedPlaces()),
      },
    ].filter((s) => s.rows.length > 0),
  );

  protected readonly isEmpty = computed(() => this.sections().length === 0);

  protected initial(name: string): string {
    return name.trim().charAt(0).toUpperCase();
  }
}

function filterRows(
  options: readonly FacetOption[],
  fragment: string,
  selected: readonly string[],
): TagRow[] {
  const needle = fragment.trim().toLowerCase();
  const matched =
    needle.length === 0 ? options : options.filter((o) => o.value.toLowerCase().includes(needle));
  return matched.map((o) => ({
    ...o,
    selected: selected.includes(o.value),
    countLabel: `${o.count} ${o.count === 1 ? 'photo' : 'photos'}`,
  }));
}
