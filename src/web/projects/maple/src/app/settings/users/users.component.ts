// UsersComponent — `/settings/users` (auth + owner-gated).
//
// Owner-only screen for inviting members. Lets the owner:
//  - issue an invite (email -> 8-char code)
//  - see pending invites with metadata
//  - rescind an unused invite
//
// The most recently issued invite is rendered with a copyable URL so the
// owner can share it; we link out to a QR encoder for convenience but do
// not bundle a QR library here.

import { Component, OnInit, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { AuthService } from '@maple-common';

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
  standalone: true,
  selector: 'maple-users',
  imports: [FormsModule],
  templateUrl: './users.component.html',
  styleUrl: './users.component.scss',
})
export class UsersComponent implements OnInit {
  private auth = inject(AuthService);

  email = '';
  invites = signal<Invite[]>([]);
  freshInvite = signal<FreshInvite | null>(null);
  busy = signal(false);
  error = signal<string | null>(null);

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

  qrSrc(payload: FreshInvite): string {
    // Encode {url, code, email} as a JSON QR payload via a public encoder.
    const data = JSON.stringify({
      url: payload.url,
      code: payload.code,
      email: payload.email,
    });
    return `https://api.qrserver.com/v1/create-qr-code/?size=180x180&data=${encodeURIComponent(data)}`;
  }
}
