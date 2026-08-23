// MuiUserManagement — Maple UI Organisms, Wave W6 Lane B "Configuration"
// (docs/unified-component-catalog.md §4.8). Invite, list, and revoke access
// for a Self Hosted deployment's users, built from ListRow, QrCode, Dialog,
// FormField.
//
// Revoke is a two-step, confirmed action: clicking a row's Revoke button
// only opens the confirm Dialog (tracking the target user in a local
// signal) — `userRevoked` fires from the Dialog's own `confirmed` output,
// never from the row click directly.

import {
  ChangeDetectionStrategy,
  Component,
  computed,
  input,
  model,
  output,
  signal,
} from '@angular/core';
import { MuiButtonComponent } from '../button/mui-button.component';
import { MuiDialogComponent } from '../dialog/mui-dialog.component';
import { MuiFormFieldComponent } from '../form-field/mui-form-field.component';
import { MuiListRowComponent } from '../list-row/mui-list-row.component';
import { MuiQrCodeComponent } from '../qr-code/mui-qr-code.component';
import { MuiTextComponent } from '../text/mui-text.component';

export interface MuiManagedUser {
  readonly id: string;
  readonly name: string;
  readonly email: string;
  readonly role: string;
}

@Component({
  selector: 'mui-user-management',
  standalone: true,
  imports: [
    MuiButtonComponent,
    MuiDialogComponent,
    MuiFormFieldComponent,
    MuiListRowComponent,
    MuiQrCodeComponent,
    MuiTextComponent,
  ],
  templateUrl: './mui-user-management.component.html',
  styleUrl: './mui-user-management.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class MuiUserManagementComponent {
  readonly users = input.required<readonly MuiManagedUser[]>();
  readonly inviteLink = input<string>('');
  readonly inviteValue = model<string>('');

  /** Fires with the invited email once the invite FormField commits. */
  readonly userInvited = output<string>();
  /** Fires with the user id — only after the confirm Dialog is confirmed. */
  readonly userRevoked = output<string>();

  readonly pendingRevoke = signal<MuiManagedUser | null>(null);
  readonly dialogOpen = computed(() => this.pendingRevoke() !== null);
  readonly dialogMessage = computed(() => {
    const user = this.pendingRevoke();
    return user ? `${user.name} (${user.email}) will lose access immediately.` : null;
  });

  requestRevoke(user: MuiManagedUser): void {
    this.pendingRevoke.set(user);
  }

  confirmRevoke(): void {
    const user = this.pendingRevoke();
    if (!user) return;
    this.userRevoked.emit(user.id);
    this.pendingRevoke.set(null);
  }

  dismissRevoke(): void {
    this.pendingRevoke.set(null);
  }

  onInviteCommitted(value: string): void {
    const trimmed = value.trim();
    if (trimmed.length === 0) return;
    this.userInvited.emit(trimmed);
    this.inviteValue.set('');
  }
}
