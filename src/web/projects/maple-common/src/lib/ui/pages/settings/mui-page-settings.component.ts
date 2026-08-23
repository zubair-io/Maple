// MuiPageSettings — Maple UI Pages (unified-component-catalog.md §6).
// Settings Shell: a section list in Nav, and — per the selected section —
// Settings Section, Device List, or User Management in the Pane.
//
// Cross-organism wiring: the Nav section list drives which organism renders
// in the Pane; a `fieldChanged` from Settings Section (editing the sync
// interval) is applied back into that organism's own row data, so the Pane
// reflects the edit rather than silently discarding it.

import { ChangeDetectionStrategy, Component, signal } from '@angular/core';
import { MuiSettingsShellComponent } from '../../settings-shell/mui-settings-shell.component';
import { MuiListRowComponent } from '../../list-row/mui-list-row.component';
import type { MapleIconName } from '../../icon/mui-icon.component';
import { MuiSettingsSectionComponent } from '../../settings-section/mui-settings-section.component';
import type {
  MuiSettingsSectionRow,
  MuiSettingsSectionFieldChange,
} from '../../settings-section/mui-settings-section.component';
import { MuiDeviceListComponent } from '../../device-list/mui-device-list.component';
import type { MuiPairedDevice } from '../../device-list/mui-device-list.component';
import { MuiUserManagementComponent } from '../../user-management/mui-user-management.component';
import type { MuiManagedUser } from '../../user-management/mui-user-management.component';

interface SettingsNavSection {
  readonly id: string;
  readonly label: string;
  readonly icon: MapleIconName;
}

const NAV_SECTIONS: readonly SettingsNavSection[] = [
  { id: 'general', label: 'General', icon: 'gear' },
  { id: 'devices', label: 'Devices', icon: 'sidebar' },
  { id: 'users', label: 'Users', icon: 'person-circle' },
];

@Component({
  selector: 'mui-page-settings',
  standalone: true,
  imports: [
    MuiSettingsShellComponent,
    MuiListRowComponent,
    MuiSettingsSectionComponent,
    MuiDeviceListComponent,
    MuiUserManagementComponent,
  ],
  templateUrl: './mui-page-settings.component.html',
  styleUrl: './mui-page-settings.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class MuiPageSettingsComponent {
  readonly navSections = NAV_SECTIONS;
  readonly activeSectionId = signal<string>('general');

  readonly settingsRows = signal<readonly MuiSettingsSectionRow[]>([
    {
      kind: 'navigate',
      id: 'storage',
      label: 'Storage location',
      value: '/Volumes/Photos',
      icon: 'folder',
    },
    {
      kind: 'edit',
      id: 'sync-interval',
      label: 'Sync interval',
      value: '15 minutes',
      help: 'How often remote sources are re-scanned.',
      icon: 'history',
    },
  ]);

  readonly devices: readonly MuiPairedDevice[] = [
    { id: 'd1', name: 'MacBook Pro', platform: 'macOS 15', lastSeen: Date.now() - 120_000 },
    { id: 'd2', name: 'iPhone 15', platform: 'iOS 19', lastSeen: Date.now() - 3_600_000 },
  ];
  readonly deviceList = signal<readonly MuiPairedDevice[]>(this.devices);

  readonly users = signal<readonly MuiManagedUser[]>([
    { id: 'u1', name: 'Ada Voss', email: 'ada@example.com', role: 'Owner' },
    { id: 'u2', name: 'Priya Nair', email: 'priya@example.com', role: 'Editor' },
  ]);

  onSettingsFieldChanged(change: MuiSettingsSectionFieldChange): void {
    this.settingsRows.update((rows) =>
      rows.map((row) => (row.id === change.id ? { ...row, value: change.value } : row)),
    );
  }

  onDeviceRevoked(id: string): void {
    this.deviceList.update((devices) => devices.filter((d) => d.id !== id));
  }

  onUserInvited(email: string): void {
    this.users.update((users) => [
      ...users,
      { id: `u${users.length + 1}`, name: email.split('@')[0], email, role: 'Viewer' },
    ]);
  }

  onUserRevoked(id: string): void {
    this.users.update((users) => users.filter((u) => u.id !== id));
  }
}
