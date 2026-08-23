// MuiSearch — the Maple UI design-system Search organism
// (unified-component-catalog.md §4.2; Built from: Search Bar, Chip Row,
// Suggestion Menu, Search Results, Filter Panel). Query, filters, and
// results composed together: a search bar with an inline suggestion
// popover, an applied-filter chip row, a togglable Filter Panel, and the
// paginated Search Results grid. Purely presentational — the caller owns
// the query, suggestions, filters, and results via inputs/outputs; the
// Filter Panel's visibility is the only state this component keeps for
// itself. Search Results already owns its own loading/empty/error
// presentation, so there's nothing extra to handle at this level.

import { ChangeDetectionStrategy, Component, input, model, output } from '@angular/core';
import type { MuiChip } from '../chip-row/mui-chip-row.component';
import { MuiChipRowComponent } from '../chip-row/mui-chip-row.component';
import type { MuiFilterGroup } from '../filter-panel/mui-filter-panel.component';
import { MuiFilterPanelComponent } from '../filter-panel/mui-filter-panel.component';
import { MuiSearchBarComponent } from '../search-bar/mui-search-bar.component';
import type { MuiCollectionItem } from '../search-results/mui-search-results.component';
import { MuiSearchResultsComponent } from '../search-results/mui-search-results.component';
import type { MuiSuggestionItem } from '../suggestion-menu/mui-suggestion-menu.component';
import { MuiSuggestionMenuComponent } from '../suggestion-menu/mui-suggestion-menu.component';

@Component({
  selector: 'mui-search',
  standalone: true,
  imports: [
    MuiChipRowComponent,
    MuiFilterPanelComponent,
    MuiSearchBarComponent,
    MuiSearchResultsComponent,
    MuiSuggestionMenuComponent,
  ],
  templateUrl: './mui-search.component.html',
  styleUrl: './mui-search.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class MuiSearchComponent {
  readonly query = model<string>('');
  readonly suggestions = input<readonly MuiSuggestionItem[]>([]);
  readonly suggestionsOpen = input<boolean>(false);
  readonly filterGroups = input<readonly MuiFilterGroup[]>([]);
  readonly activeChips = input<readonly MuiChip[]>([]);
  readonly results = input.required<readonly MuiCollectionItem[]>();
  readonly resultsLoading = input<boolean>(false);
  readonly totalCount = input<number>(0);
  readonly page = input<number>(1);
  readonly pageCount = input<number>(1);

  readonly resultSelectedIds = model<readonly string[]>([]);
  /** Toggles the Filter Panel's visibility — flipped by the search bar's
   * "Filters" action button. */
  readonly showFilters = model<boolean>(false);

  readonly committed = output<string>();
  readonly suggestionSelected = output<string>();
  readonly chipRemoved = output<string>();
  readonly filterOptionToggled = output<{ groupId: string; optionId: string; checked: boolean }>();
  readonly opened = output<string>();
  readonly pageChanged = output<number>();

  onSuggestionSelect(id: string): void {
    this.suggestionSelected.emit(id);
  }
}
