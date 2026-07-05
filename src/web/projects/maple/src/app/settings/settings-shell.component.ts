// SettingsShellComponent — left sidebar + right pane layout shared by the
// Settings surfaces (Account, Workers, People, Users). Replaces the
// previous card-grid landing page; per the v0.2 spec, Settings is one
// window and the sidebar item determines which page is rendered on the
// right.

import { ChangeDetectionStrategy, Component, computed, inject, input } from '@angular/core';
import { RouterLink } from '@angular/router';
import { AuthService } from '@maple-common';
import { SettingsIconComponent, type SettingsIconName } from './settings-icon.component';

export type SettingsSection =
  | 'account'
  | 'workers'
  | 'imports'
  | 'people'
  | 'users'
  | 'observability'
  | 'network'
  | 'pano'
  | 'cloudflare';

interface NavItem {
  readonly id: SettingsSection;
  readonly label: string;
  readonly icon: SettingsIconName;
  readonly link: string;
  readonly ownerOnly: boolean;
  readonly sub?: string;
}

const ITEMS: readonly NavItem[] = [
  { id: 'account', label: 'Account', icon: 'user', link: '/settings/account', ownerOnly: false },
  {
    id: 'workers',
    label: 'Workers',
    icon: 'pipe',
    link: '/settings/workers',
    ownerOnly: true,
    sub: 'Pipeline + enrichment',
  },
  {
    id: 'imports',
    label: 'Imports',
    icon: 'copy',
    link: '/settings/imports',
    ownerOnly: true,
    sub: 'Copy a folder into a library',
  },
  { id: 'people', label: 'People', icon: 'people', link: '/settings/people', ownerOnly: true },
  {
    id: 'observability',
    label: 'Observability',
    icon: 'globe',
    link: '/settings/observability',
    ownerOnly: true,
    sub: 'SigNoz telemetry',
  },
  {
    id: 'network',
    label: 'Network',
    icon: 'wifi',
    link: '/settings/network',
    ownerOnly: true,
    sub: 'LAN address for local connections',
  },
  {
    id: 'pano',
    label: 'Pano',
    icon: 'image',
    link: '/settings/pano',
    ownerOnly: true,
    sub: 'Panorama stitching',
  },
  { id: 'users', label: 'Users', icon: 'key', link: '/settings/users', ownerOnly: true },
  {
    id: 'cloudflare',
    label: 'Cloudflare',
    icon: 'globe',
    link: '/settings/cloudflare',
    ownerOnly: true,
    sub: 'Edge thumbnail cache',
  },
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
