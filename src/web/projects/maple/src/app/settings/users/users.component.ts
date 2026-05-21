// UsersComponent — `/settings/users` (auth + owner-gated).
//
// Two sections: a Members row for the signed-in user (AuthService only
// exposes the current `user` signal — there's no server endpoint for a
// full member roster yet) and Invite codes. Owners can issue invites and
// rescind unconsumed ones. The fresh-invite card surfaces the share URL +
// QR for quick handoff.

import {
  ChangeDetectionStrategy,
  Component,
  OnInit,
  computed,
  inject,
  signal,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import { AuthService } from '@maple-common';
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
  imports: [FormsModule, SettingsShellComponent, SettingsIconComponent],
  templateUrl: './users.component.html',
  styleUrl: './users.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class UsersComponent implements OnInit {
  protected auth = inject(AuthService);

  protected email = '';
  protected readonly invites = signal<Invite[]>([]);
  protected readonly freshInvite = signal<FreshInvite | null>(null);
  protected readonly busy = signal(false);
  protected readonly error = signal<string | null>(null);
  protected readonly showInviteForm = signal(false);

  protected readonly currentUser = computed(() => this.auth.user());

  async ngOnInit(): Promise<void> {
    await this.refresh();
  }

  private async refresh(): Promise<void> {
    try {
      const list = await this.auth.listInvites();
      this.invites.set(list as Invite[]);
    } catch (e: unknown) {
      this.error.set(e instanceof Error ? e.message : String(e));
    }
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
      this.error.set(e instanceof Error ? e.message : String(e));
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
      this.error.set(e instanceof Error ? e.message : String(e));
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
