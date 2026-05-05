// AccountComponent — `/settings/account` (auth-gated).
//
// Lets the signed-in user manage their own passkeys (add another device,
// delete an existing credential) and sign out. The credentials list is
// fetched directly from `/api/auth/me` since AuthService only exposes the
// `user` signal — see Task C5 notes.

import { Component, OnInit, inject, signal } from '@angular/core';
import { Router } from '@angular/router';
import { HttpClient } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';
import { AuthService } from '@maple-common';

interface Credential {
  id: string;
  device_label: string;
  last_used_at: string | null;
  created_at: string;
}

@Component({
  standalone: true,
  selector: 'maple-account',
  imports: [],
  templateUrl: './account.component.html',
  styleUrl: './account.component.scss',
})
export class AccountComponent implements OnInit {
  protected auth = inject(AuthService);
  private router = inject(Router);
  private http = inject(HttpClient);

  credentials = signal<Credential[]>([]);
  busy = signal(false);
  error = signal<string | null>(null);

  async ngOnInit(): Promise<void> {
    await this.refresh();
  }

  private async refresh(): Promise<void> {
    try {
      const r = await firstValueFrom(
        this.http.get<{ user: unknown; credentials: Credential[] }>(
          '/api/auth/me',
        ),
      );
      this.credentials.set(r.credentials ?? []);
    } catch (e: unknown) {
      this.error.set(e instanceof Error ? e.message : String(e));
    }
  }

  async addDevice(): Promise<void> {
    this.busy.set(true);
    this.error.set(null);
    try {
      await this.auth.addCredential('Web');
      await this.refresh();
    } catch (e: unknown) {
      this.error.set(e instanceof Error ? e.message : String(e));
    } finally {
      this.busy.set(false);
    }
  }

  async deleteDevice(id: string): Promise<void> {
    this.busy.set(true);
    this.error.set(null);
    try {
      await this.auth.deleteCredential(id);
      await this.refresh();
    } catch (e: unknown) {
      // Server refuses deletion of the last credential — surface the error.
      this.error.set(e instanceof Error ? e.message : String(e));
    } finally {
      this.busy.set(false);
    }
  }

  async signOut(): Promise<void> {
    await this.auth.signOut();
    await this.router.navigate(['/sign-in']);
  }
}
