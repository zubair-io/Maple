// MuiVersionHistoryPanel — Maple UI Organisms (unified-component-catalog.md
// §4.3 "Inspectors & panels"). Browse and restore versions — built from
// List Row, Timestamp, Button, Dialog. Mirrors Presets Panel's confirm-then-
// emit shape: `restored` only fires after the confirm dialog round-trips,
// never straight off the row press.

import { ChangeDetectionStrategy, Component, input, output, signal } from '@angular/core';
import { MuiButtonComponent } from '../button/mui-button.component';
import { MuiDialogComponent } from '../dialog/mui-dialog.component';
import { MuiEmptyStateComponent } from '../empty-state/mui-empty-state.component';
import { MuiListRowComponent } from '../list-row/mui-list-row.component';
import { MuiSpinnerComponent } from '../spinner/mui-spinner.component';
import { MuiTextComponent } from '../text/mui-text.component';

export interface MuiVersionItem {
  readonly id: string;
  readonly label: string;
  readonly timestampValue: Date | number | string;
  readonly current?: boolean;
}

@Component({
  selector: 'mui-version-history-panel',
  standalone: true,
  imports: [
    MuiButtonComponent,
    MuiDialogComponent,
    MuiEmptyStateComponent,
    MuiListRowComponent,
    MuiSpinnerComponent,
    MuiTextComponent,
  ],
  templateUrl: './mui-version-history-panel.component.html',
  styleUrl: './mui-version-history-panel.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class MuiVersionHistoryPanelComponent {
  readonly versions = input.required<readonly MuiVersionItem[]>();
  readonly loading = input<boolean>(false);

  readonly restored = output<string>();

  readonly pendingRestoreId = signal<string | null>(null);

  openConfirm(id: string, event: MouseEvent): void {
    event.stopPropagation();
    this.pendingRestoreId.set(id);
  }

  confirmRestore(): void {
    const id = this.pendingRestoreId();
    if (id) this.restored.emit(id);
    this.pendingRestoreId.set(null);
  }

  closeDialog(): void {
    this.pendingRestoreId.set(null);
  }
}
