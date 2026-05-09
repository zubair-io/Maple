// SettingsIndexComponent — `/settings` landing page.
//
// Card grid linking out to every settings surface. Owner-only surfaces are
// labelled with a small "owner" pill; the route guards on the destination
// pages still enforce access (the pill is informational, not a security
// boundary).

import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { RouterLink } from '@angular/router';
import { AuthService, MaterialIconComponent } from '@maple-common';

interface SettingsCard {
  readonly icon: string;
  readonly title: string;
  readonly description: string;
  readonly link: string;
  readonly ownerOnly: boolean;
}

@Component({
  standalone: true,
  selector: 'maple-settings-index',
  imports: [RouterLink, MaterialIconComponent],
  templateUrl: './settings-index.component.html',
  styleUrl: './settings-index.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class SettingsIndexComponent {
  protected auth = inject(AuthService);

  protected readonly cards = computed<SettingsCard[]>(() => [
    {
      icon: 'person',
      title: 'Account',
      description: 'Manage your passkeys, signed-in devices, and sign out.',
      link: '/settings/account',
      ownerOnly: false,
    },
    {
      icon: 'manage_search',
      title: 'Indexer',
      description: 'Library indexing pipeline — start, stop, and inspect dead-letters.',
      link: '/settings/indexer',
      ownerOnly: true,
    },
    {
      icon: 'auto_awesome',
      title: 'Enrichment',
      description: 'Geocoding, captioning, face detection, and OCR workers.',
      link: '/settings/enrichment',
      ownerOnly: true,
    },
    {
      icon: 'settings_applications',
      title: 'Workers',
      description: 'Monitor and tune every pipeline stage — status, throughput, dead-letter retry.',
      link: '/settings/workers',
      ownerOnly: true,
    },
    {
      icon: 'groups',
      title: 'People',
      description: 'Face clusters, identities, and per-person merging.',
      link: '/people',
      ownerOnly: true,
    },
    {
      icon: 'key',
      title: 'Users',
      description: 'Invite codes, registered members, and credential audit.',
      link: '/settings/users',
      ownerOnly: true,
    },
  ]);

  protected readonly isOwner = computed(() => this.auth.user()?.role === 'owner');
}
