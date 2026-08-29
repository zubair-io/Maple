// MuiShareModal — Maple UI Organisms (Wave W6 Lane B). Manage who has
// access to a shared item — built from Overlay Shell, Avatar Group, Form
// Field, List Row.

import { ChangeDetectionStrategy, Component, computed, input, model, output } from '@angular/core';
import { MuiAvatarGroupComponent } from '../avatar-group/mui-avatar-group.component';
import type { MuiAvatarGroupMember } from '../avatar-group/mui-avatar-group.component';
import { MuiButtonComponent } from '../button/mui-button.component';
import { MuiFormFieldComponent } from '../form-field/mui-form-field.component';
import { MuiListRowComponent } from '../list-row/mui-list-row.component';
import { MuiOverlayShellComponent } from '../overlay-shell/mui-overlay-shell.component';

export interface MuiShareMember {
  readonly id: string;
  readonly name: string;
  readonly role: string;
  readonly avatarUrl?: string | null;
}

@Component({
  selector: 'mui-share-modal',
  standalone: true,
  imports: [
    MuiAvatarGroupComponent,
    MuiButtonComponent,
    MuiFormFieldComponent,
    MuiListRowComponent,
    MuiOverlayShellComponent,
  ],
  templateUrl: './mui-share-modal.component.html',
  styleUrl: './mui-share-modal.component.scss',
  host: { class: 'contents' },
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class MuiShareModalComponent {
  readonly open = input<boolean>(false);
  readonly members = input.required<readonly MuiShareMember[]>();
  readonly inviteValue = model<string>('');

  readonly memberInvited = output<string>();
  readonly memberRemoved = output<string>();
  readonly dismissed = output<void>();

  readonly avatarMembers = computed<readonly MuiAvatarGroupMember[]>(() =>
    this.members().map((member) => ({ name: member.name, src: member.avatarUrl ?? null })),
  );

  readonly canInvite = computed(() => this.inviteValue().trim().length > 0);

  invite(): void {
    const trimmed = this.inviteValue().trim();
    if (trimmed.length === 0) return;
    this.memberInvited.emit(trimmed);
    this.inviteValue.set('');
  }

  removeMember(id: string): void {
    this.memberRemoved.emit(id);
  }

  onDismiss(): void {
    this.dismissed.emit();
  }
}
