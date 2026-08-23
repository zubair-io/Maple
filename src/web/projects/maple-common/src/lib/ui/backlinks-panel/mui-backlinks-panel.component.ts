// MuiBacklinksPanel — the Maple UI design-system Backlinks Panel organism
// (unified-component-catalog.md §4.3; Built from: List Row, Empty State).
// Inbound-reference list for the active asset/page.

import { ChangeDetectionStrategy, Component, input, output } from '@angular/core';
import { MuiEmptyStateComponent } from '../empty-state/mui-empty-state.component';
import type { MapleIconName } from '../icon/mui-icon.component';
import { MuiListRowComponent } from '../list-row/mui-list-row.component';
import { MuiSpinnerComponent } from '../spinner/mui-spinner.component';

export interface MuiBacklinkItem {
  readonly id: string;
  readonly icon?: MapleIconName | null;
  readonly label: string;
  readonly subtitle?: string | null;
}

@Component({
  selector: 'mui-backlinks-panel',
  standalone: true,
  imports: [MuiEmptyStateComponent, MuiListRowComponent, MuiSpinnerComponent],
  templateUrl: './mui-backlinks-panel.component.html',
  styleUrl: './mui-backlinks-panel.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class MuiBacklinksPanelComponent {
  readonly links = input.required<readonly MuiBacklinkItem[]>();
  readonly loading = input<boolean>(false);
  readonly emptyMessage = input<string>('No backlinks yet.');

  readonly pressed = output<string>();
}
