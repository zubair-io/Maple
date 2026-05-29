// SearchScopeChipsComponent — single-select scope row for S7 (#622).
//
// Spec: docs/design/responsive-program/s7-search.md §2.
//
// Renders one chip per `SearchScope` value. Tap emits `scopeChange` —
// the host issues a fresh `SearchService.search()` with the new scope
// mapped into `SearchParams`. v0.1: only `all` and `photos` hit the
// network (same params); `places`, `people`, `albums` are stubbed
// pending a backend `scope` extension.

import { ChangeDetectionStrategy, Component, input, output } from '@angular/core';
import { SearchScope, SEARCH_SCOPES } from './search-types';

interface ScopeChip {
  scope: SearchScope;
  label: string;
}

const CHIPS: readonly ScopeChip[] = [
  { scope: 'all', label: 'All' },
  { scope: 'photos', label: 'Photos' },
  { scope: 'places', label: 'Places' },
  { scope: 'people', label: 'People' },
  { scope: 'albums', label: 'Albums' },
];

@Component({
  selector: 'app-search-scope-chips',
  standalone: true,
  templateUrl: './search-scope-chips.component.html',
  styleUrl: './search-scope-chips.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class SearchScopeChipsComponent {
  /** Currently-selected scope. */
  readonly scope = input<SearchScope>('all');
  /** Emitted when the user taps a different chip. */
  readonly scopeChange = output<SearchScope>();

  protected readonly chips = CHIPS;
  /** Validate at construction that the chip list matches the union — a
   * future scope added to `SEARCH_SCOPES` without updating `CHIPS` should
   * crash loudly in tests, not silently miss a chip in the UI. */
  constructor() {
    const missing = SEARCH_SCOPES.filter((s) => !CHIPS.some((c) => c.scope === s));
    if (missing.length > 0) {
      throw new Error(`SearchScopeChips: missing chips for ${missing.join(', ')}`);
    }
  }

  protected onSelect(scope: SearchScope): void {
    if (scope === this.scope()) return;
    this.scopeChange.emit(scope);
  }

  protected trackScope = (_: number, c: ScopeChip) => c.scope;
}
