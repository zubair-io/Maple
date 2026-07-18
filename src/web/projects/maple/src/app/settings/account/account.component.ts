// AccountComponent — `/settings/account` (auth-gated).
//
// Surface for the signed-in user's identity and their registered passkeys.
// Lists credentials inline (each with a delete affordance) and exposes a
// "Sign out" action. Wrapped in the SettingsShell so the sidebar nav is
// consistent across every settings surface.

import {
  ChangeDetectionStrategy,
  Component,
  OnInit,
  computed,
  inject,
  signal,
} from '@angular/core';
import { Router } from '@angular/router';
import { HttpClient } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';
import { AuthService, errorMessage, BunApiBackendService } from '@maple-common';
import { SettingsShellComponent } from '../settings-shell.component';
import { SettingsIconComponent } from '../settings-icon.component';
import { PairedDevicesComponent } from './paired-devices.component';

interface Credential {
  id: string;
  device_label: string;
  last_used_at: string | null;
  created_at: string;
}

@Component({
  selector: 'maple-account',
  standalone: true,
  imports: [SettingsShellComponent, SettingsIconComponent, PairedDevicesComponent],
  templateUrl: './account.component.html',
  styleUrl: './account.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class AccountComponent implements OnInit {
  protected auth = inject(AuthService);
  private router = inject(Router);
  private http = inject(HttpClient);
  private displayApi = inject(BunApiBackendService);

  protected readonly credentials = signal<Credential[]>([]);
  protected readonly busy = signal(false);
  protected readonly error = signal<string | null>(null);
  protected readonly showHidden = signal<boolean>(false);

  protected readonly user = computed(() => this.auth.user());
  protected readonly isOwner = computed(() => this.auth.user()?.role === 'owner');

  async ngOnInit(): Promise<void> {
    await this.refresh();
    this.fetchDisplayConfig();
  }

  private async refresh(): Promise<void> {
    try {
      const r = await firstValueFrom(
        this.http.get<{ user: unknown; credentials: Credential[] }>('/api/auth/me'),
      );
      this.credentials.set(r.credentials ?? []);
    } catch (e: unknown) {
      this.error.set(errorMessage(e));
    }
  }

  async addDevice(): Promise<void> {
    this.busy.set(true);
    this.error.set(null);
    try {
      await this.auth.addCredential('Web');
      await this.refresh();
    } catch (e: unknown) {
      this.error.set(errorMessage(e));
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
      this.error.set(errorMessage(e));
    } finally {
      this.busy.set(false);
    }
  }

  async signOut(): Promise<void> {
    await this.auth.signOut();
    await this.router.navigate(['/sign-in']);
  }

  private fetchDisplayConfig(): void {
    this.displayApi.getDisplayConfig().subscribe({
      next: (config) => this.showHidden.set(config.show_hidden_images),
      error: () => {},
    });
  }

  protected toggleShowHidden(): void {
    const nextVal = !this.showHidden();
    this.displayApi.saveDisplayConfig({ show_hidden_images: nextVal }).subscribe({
      next: (res) => {
        if (res.ok) {
          this.showHidden.set(nextVal);
        }
      },
    });
  }
}
