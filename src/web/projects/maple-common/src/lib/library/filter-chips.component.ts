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
  host: { class: 'block' },
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class FilterChipsComponent {
  /** Currently-active filter. Parent owns the source of truth. */
  active = input.required<CullFilter>();

  /** Mutually-exclusive color/border/background triplet for a chip's
   * active state (Tailwind port #3071) — folded into one computed string
   * rather than a base class plus a conditional add-on. */
  protected chipClass(active: boolean): string {
    // `--font-lato-bold` is never defined globally, so the effective stack
    // is always its fallback — written directly rather than through an
    // unresolvable `var()` inside a Tailwind arbitrary value.
    const base =
      "inline-flex h-7 cursor-pointer items-center justify-center rounded-full border-[0.5px] px-2.5 font-['Lato_Bold',system-ui,sans-serif] text-[11px] font-bold transition-[background-color,color,border-color] duration-[var(--motion-filter-fade-ms,120ms)] ease-linear focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary";
    return active
      ? `${base} active border-primary text-primary bg-[color-mix(in_srgb,var(--color-primary)_22%,transparent)]`
      : `${base} border-border bg-surface-alt text-text-muted`;
  }

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
