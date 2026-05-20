// SettingsShellComponent — left sidebar + right pane layout shared by the
// Settings surfaces (Account, Workers, Users). Replaces the previous
// card-grid landing page; per the v0.2 spec, Settings is one window and
// the sidebar item determines which page is rendered on the right.
//
// The "People" sidebar entry routes to the existing `/people` page, which
// is NOT yet wrapped in this shell — clicking it exits the settings shell.
// Bringing People into the shell is a tracked follow-up.

import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
  input,
} from '@angular/core';
import { RouterLink } from '@angular/router';
import { AuthService } from '@maple-common';
import { SettingsIconComponent, type SettingsIconName } from './settings-icon.component';

export type SettingsSection = 'account' | 'workers' | 'people' | 'users';

interface NavItem {
  readonly id: SettingsSection;
  readonly label: string;
  readonly icon: SettingsIconName;
  readonly link: string;
  readonly ownerOnly: boolean;
  readonly sub?: string;
}

const ITEMS: readonly NavItem[] = [
  { id: 'account', label: 'Account', icon: 'user',   link: '/settings/account', ownerOnly: false },
  { id: 'workers', label: 'Workers', icon: 'pipe',   link: '/settings/workers', ownerOnly: true, sub: 'Pipeline + enrichment' },
  { id: 'people',  label: 'People',  icon: 'people', link: '/people',           ownerOnly: true },
  { id: 'users',   label: 'Users',   icon: 'key',    link: '/settings/users',   ownerOnly: true },
];

@Component({
  selector: 'maple-settings-shell',
  standalone: true,
  imports: [RouterLink, SettingsIconComponent],
  templateUrl: './settings-shell.component.html',
  styleUrl: './settings-shell.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class SettingsShellComponent {
  /** Which sidebar entry is highlighted. */
  readonly section = input.required<SettingsSection>();

  private readonly auth = inject(AuthService);

  protected readonly items = computed<readonly NavItem[]>(() => {
    const isOwner = this.auth.user()?.role === 'owner';
    return ITEMS.filter((it) => !it.ownerOnly || isOwner);
  });

  protected readonly userEmail = computed(() => this.auth.user()?.email ?? '');
}
