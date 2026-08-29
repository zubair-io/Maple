// UsersComponent — `/settings/users` (auth + owner-gated).
//
// Two sections: the full member roster (GET /api/users, #2893) with a
// per-member "file access" toggle, and Invite codes. Owners can issue
// invites and rescind unconsumed ones. The fresh-invite card surfaces the
// share URL + QR for quick handoff.

import {
  ChangeDetectionStrategy,
  Component,
  OnInit,
  computed,
  inject,
  signal,
} from '@angular/core';
import { firstValueFrom } from 'rxjs';
import {
  type ApiUser,
  AuthService,
  BunApiBackendService,
  errorMessage,
  MuiButtonComponent,
  MuiCheckboxComponent,
  MuiInputComponent,
} from '@maple-common';
import { SettingsShellComponent } from '../settings-shell.component';
import { SettingsIconComponent } from '../settings-icon.component';

interface Invite {
  code: string;
  email: string;
  expires_at: string;
  consumed_at: string | null;
}

interface FreshInvite {
  code: string;
  email: string;
  url: string;
  expires_at: string;
}

@Component({
  selector: 'maple-users',
  standalone: true,
  imports: [
    SettingsShellComponent,
    SettingsIconComponent,
    MuiButtonComponent,
    MuiCheckboxComponent,
    MuiInputComponent,
  ],
  templateUrl: './users.component.html',
  styleUrl: './users.component.scss',
  host: { class: 'set-vars set-page-host' },
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class UsersComponent implements OnInit {
  protected auth = inject(AuthService);
  private readonly api = inject(BunApiBackendService);

  protected email = '';
  protected readonly users = signal<ApiUser[]>([]);
  protected readonly invites = signal<Invite[]>([]);
  protected readonly freshInvite = signal<FreshInvite | null>(null);
  protected readonly busy = signal(false);
  protected readonly error = signal<string | null>(null);
  protected readonly showInviteForm = signal(false);
  /** User id whose file-access PATCH is in flight (disables that toggle). */
  protected readonly togglingId = signal<string | null>(null);

  protected readonly currentUser = computed(() => this.auth.user());

  async ngOnInit(): Promise<void> {
    await this.refresh();
  }

  private async refresh(): Promise<void> {
    try {
      const [users, list] = await Promise.all([
        firstValueFrom(this.api.listUsers()),
        this.auth.listInvites(),
      ]);
      this.users.set(users);
      this.invites.set(list as Invite[]);
    } catch (e: unknown) {
      this.error.set(errorMessage(e));
    }
  }

  async setRole(user: ApiUser, role: 'owner' | 'member'): Promise<void> {
    if (role === user.role) return;
    this.togglingId.set(user.id);
    this.error.set(null);
    try {
      const updated = await firstValueFrom(this.api.setUserRole(user.id, role));
      this.users.update((list) => list.map((u) => (u.id === updated.id ? updated : u)));
    } catch (e: unknown) {
      this.error.set(errorMessage(e));
    } finally {
      this.togglingId.set(null);
    }
  }

  async setFileAccess(user: ApiUser, granted: boolean): Promise<void> {
    this.togglingId.set(user.id);
    this.error.set(null);
    try {
      const updated = await firstValueFrom(this.api.setUserFileAccess(user.id, granted));
      this.users.update((list) => list.map((u) => (u.id === updated.id ? updated : u)));
    } catch (e: unknown) {
      this.error.set(errorMessage(e));
    } finally {
      this.togglingId.set(null);
    }
  }

  protected lastSeenLabel(u: ApiUser): string {
    if (u.id === this.currentUser()?.id) return 'now';
    if (!u.last_seen_at) return '—';
    const seen = new Date(u.last_seen_at);
    return Number.isNaN(seen.getTime()) ? u.last_seen_at : seen.toLocaleString();
  }

  openInvite(): void {
    this.showInviteForm.set(true);
  }

  async createInvite(): Promise<void> {
    if (!this.email) return;
    this.busy.set(true);
    this.error.set(null);
    try {
      const r = await this.auth.createInvite(this.email);
      const url = `${window.location.origin}/join`;
      this.freshInvite.set({
        code: r.code,
        email: this.email,
        url,
        expires_at: r.expires_at,
      });
      this.email = '';
      this.showInviteForm.set(false);
      await this.refresh();
    } catch (e: unknown) {
      this.error.set(errorMessage(e));
    } finally {
      this.busy.set(false);
    }
  }

  async rescind(code: string): Promise<void> {
    this.busy.set(true);
    this.error.set(null);
    try {
      await this.auth.rescindInvite(code);
      const fresh = this.freshInvite();
      if (fresh && fresh.code === code) this.freshInvite.set(null);
      await this.refresh();
    } catch (e: unknown) {
      this.error.set(errorMessage(e));
    } finally {
      this.busy.set(false);
    }
  }

  copyCode(code: string): void {
    if (typeof navigator !== 'undefined' && 'clipboard' in navigator) {
      void navigator.clipboard.writeText(code);
    }
  }

  qrSrc(payload: FreshInvite): string {
    const data = JSON.stringify({
      url: payload.url,
      code: payload.code,
      email: payload.email,
    });
    return `https://api.qrserver.com/v1/create-qr-code/?size=180x180&data=${encodeURIComponent(data)}`;
  }

  avatarColor(email: string): string {
    let hash = 0;
    for (let i = 0; i < email.length; i++) {
      hash = (hash * 31 + email.charCodeAt(i)) | 0;
    }
    const hue = Math.abs(hash) % 360;
    return `hsl(${hue}, 30%, 35%)`;
  }
}
