// MuiAvatarGroup — the Maple UI design-system Avatar Group molecule
// (unified-component-catalog.md §2.5; Built from: Avatar, Badge). Overlapping
// avatars with a "+N" overflow badge once the list exceeds `max`.

import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';
import { MuiAvatarComponent } from '../avatar/mui-avatar.component';
import type { MuiAvatarSize } from '../avatar/mui-avatar.component';
import { MuiBadgeComponent } from '../badge/mui-badge.component';

export interface MuiAvatarGroupMember {
  readonly name: string;
  readonly src?: string | null;
}

@Component({
  selector: 'mui-avatar-group',
  standalone: true,
  imports: [MuiAvatarComponent, MuiBadgeComponent],
  templateUrl: './mui-avatar-group.component.html',
  host: { class: 'block' },
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class MuiAvatarGroupComponent {
  readonly avatars = input.required<readonly MuiAvatarGroupMember[]>();
  readonly max = input<number>(3);
  readonly size = input<MuiAvatarSize>('sm');

  readonly visible = computed(() => this.avatars().slice(0, this.max()));
  readonly overflowCount = computed(() => Math.max(0, this.avatars().length - this.max()));
}
