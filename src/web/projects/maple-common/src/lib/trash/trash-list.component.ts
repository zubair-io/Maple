// TrashListComponent — the Trash panel's item list body: the mutation
// toast, load-error banner, empty state, the item rows, the loading
// indicator, and "Load more" (#2749 review: extracted out of
// `trash-panel.component.html` to help clear a fallow-audit-web
// template-complexity finding on that file). Plain presentational
// component, no HTTP of its own — `TrashPanelComponent` still owns all the
// data fetching/mutation calls and just passes state down / receives
// intent back up.

import { ChangeDetectionStrategy, Component, input, output } from '@angular/core';
import { TrashItemRowComponent } from './trash-item-row.component';
import { TrashStatusBannerComponent } from './trash-status-banner.component';
import type { AssetId } from '../models/asset';
import type { TrashItem } from './trash.types';

@Component({
  selector: 'app-trash-list',
  standalone: true,
  imports: [TrashItemRowComponent, TrashStatusBannerComponent],
  templateUrl: './trash-list.component.html',
  styleUrl: './trash-list.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class TrashListComponent {
  readonly items = input.required<TrashItem[]>();
  /** Row currently mid-restore/delete, or `'*'` while a toolbar-level batch
   * (Restore All / Empty Trash) is in flight — see
   * `TrashPanelComponent.busyKey`'s doc comment. */
  readonly busyKey = input<AssetId | '*' | null>(null);
  readonly loading = input(false);
  readonly loadError = input<string | null>(null);
  readonly nextCursor = input<string | null>(null);
  readonly toast = input<string | null>(null);

  readonly restore = output<TrashItem>();
  readonly deletePermanently = output<TrashItem>();
  readonly loadMore = output<void>();
  readonly dismissToast = output<void>();

  isRowBusy(assetId: AssetId): boolean {
    const key = this.busyKey();
    return key === assetId || key === '*';
  }
}
