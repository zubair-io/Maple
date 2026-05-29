// filter-chips.component.ts — S2 (#623). Single-select chip row over
// the Library grid: All / Picks / 4+ stars / Edited.
//
// Active chip = `MapleTokens.primary` 22% fill + `MapleTokens.primary`
// border + `MapleTokens.primary` text. Idle chip = `MapleTokens.surfaceAlt`
// fill + `MapleTokens.border` border + `MapleTokens.textMuted` text. See
// spec §2 (phone) and §4 (web mirror). Emits the new value via
// `filterChange` so the parent owns persistence + grid filtering.

import { ChangeDetectionStrategy, Component, computed, input, output } from '@angular/core';
import { CullFilter } from '../state/browse-preferences.service';

/** Display label per filter value. Kept here so the component owns its
 *  own copy and tests can assert on the rendered text. */
const FILTER_LABELS: Record<CullFilter, string> = {
  all: 'All',
  picks: 'Picks',
  '4stars': '4+ stars',
  edited: 'Edited',
};

const FILTER_ORDER: CullFilter[] = ['all', 'picks', '4stars', 'edited'];

@Component({
  selector: 'app-filter-chips',
  standalone: true,
  templateUrl: './filter-chips.component.html',
  styleUrl: './filter-chips.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class FilterChipsComponent {
  /** Currently-active filter. Parent owns the source of truth. */
  active = input.required<CullFilter>();

  /** Emitted when the user taps a chip. Parent persists + re-filters. */
  filterChange = output<CullFilter>();

  readonly chips = computed(() =>
    FILTER_ORDER.map((value) => ({ value, label: FILTER_LABELS[value] })),
  );

  onChipClick(value: CullFilter): void {
    if (this.active() === value) return;
    this.filterChange.emit(value);
  }
}
