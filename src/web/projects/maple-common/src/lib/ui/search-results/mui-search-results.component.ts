// MuiSearchResults — Maple UI Organisms · Collections
// (unified-component-catalog.md §4.1). Paginated result grid with states,
// built from Collection Grid, Empty State, Progress.

import { ChangeDetectionStrategy, Component, input, model, output } from '@angular/core';
import { MuiButtonComponent } from '../button/mui-button.component';
import { MuiCollectionGridComponent } from '../collection-grid/mui-collection-grid.component';
import type { MuiCollectionItem } from '../collection-grid/mui-collection-grid.component';
import { MuiEmptyStateComponent } from '../empty-state/mui-empty-state.component';
import { MuiProgressComponent } from '../progress/mui-progress.component';
import { MuiTextComponent } from '../text/mui-text.component';

// Re-exported so a sibling organism can import the shared item shape from
// this file too, instead of reaching back into Collection Grid directly.
export type { MuiCollectionItem } from '../collection-grid/mui-collection-grid.component';

@Component({
  selector: 'mui-search-results',
  standalone: true,
  imports: [
    MuiButtonComponent,
    MuiCollectionGridComponent,
    MuiEmptyStateComponent,
    MuiProgressComponent,
    MuiTextComponent,
  ],
  templateUrl: './mui-search-results.component.html',
  host: { class: 'block' },
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class MuiSearchResultsComponent {
  readonly items = input.required<readonly MuiCollectionItem[]>();
  readonly loading = input<boolean>(false);
  readonly query = input<string>('');
  readonly totalCount = input<number>(0);
  readonly page = input<number>(1);
  readonly pageCount = input<number>(1);
  readonly columns = input<number>(4);

  readonly selectedIds = model<readonly string[]>([]);

  readonly opened = output<string>();
  readonly pageChanged = output<number>();
}
