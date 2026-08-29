// MuiDeviceList — Maple UI Organisms, Wave W6 Lane B "Configuration"
// (docs/unified-component-catalog.md §4.8). Paired devices (macOS, iOS,
// iPadOS, Windows clients) with revoke, built from ListRow, Dialog,
// EmptyState.
//
// Same confirmed-revoke shape as MuiUserManagement: the row's Revoke button
// only opens the Dialog (target device tracked in a local signal);
// `deviceRevoked` fires from the Dialog's `confirmed` output alone.

import { ChangeDetectionStrategy, Component, computed, input, output, signal } from '@angular/core';
import { MuiButtonComponent } from '../button/mui-button.component';
import { MuiDialogComponent } from '../dialog/mui-dialog.component';
import { MuiEmptyStateComponent } from '../empty-state/mui-empty-state.component';
import { MuiListRowComponent } from '../list-row/mui-list-row.component';

export interface MuiPairedDevice {
  readonly id: string;
  readonly name: string;
  readonly platform: string;
  readonly lastSeen: Date | number | string;
}

@Component({
  selector: 'mui-device-list',
  standalone: true,
  imports: [MuiButtonComponent, MuiDialogComponent, MuiEmptyStateComponent, MuiListRowComponent],
  templateUrl: './mui-device-list.component.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'block' },
})
export class MuiDeviceListComponent {
  readonly devices = input.required<readonly MuiPairedDevice[]>();

  /** Fires with the device id — only after the confirm Dialog is confirmed. */
  readonly deviceRevoked = output<string>();

  readonly pendingRevoke = signal<MuiPairedDevice | null>(null);
  readonly dialogOpen = computed(() => this.pendingRevoke() !== null);
  readonly dialogMessage = computed(() => {
    const device = this.pendingRevoke();
    return device ? `${device.name} will be signed out and lose sync access.` : null;
  });

  requestRevoke(device: MuiPairedDevice): void {
    this.pendingRevoke.set(device);
  }

  confirmRevoke(): void {
    const device = this.pendingRevoke();
    if (!device) return;
    this.deviceRevoked.emit(device.id);
    this.pendingRevoke.set(null);
  }

  dismissRevoke(): void {
    this.pendingRevoke.set(null);
  }
}
