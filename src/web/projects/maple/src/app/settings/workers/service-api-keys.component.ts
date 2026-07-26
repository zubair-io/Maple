import { DatePipe } from '@angular/common';
import { ChangeDetectionStrategy, Component, DestroyRef, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { AuthService, type CreatedServiceApiKey, type ServiceApiKey } from '@maple-common';
import { SettingsIconComponent } from '../settings-icon.component';

type ExpiryChoice = '30' | '90' | '365' | 'never';
type CopiedValue = 'endpoint' | 'key' | null;

@Component({
  selector: 'maple-service-api-keys',
  standalone: true,
  imports: [DatePipe, FormsModule, SettingsIconComponent],
  templateUrl: './service-api-keys.component.html',
  styleUrl: './service-api-keys.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ServiceApiKeysComponent {
  private readonly auth = inject(AuthService);
  private readonly destroyRef = inject(DestroyRef);
  private copyResetTimer: ReturnType<typeof setTimeout> | undefined;

  protected name = 'SugarMaple';
  protected expiry: ExpiryChoice = '90';
  protected readonly endpoint = `${globalThis.location?.origin ?? ''}/api/search/assets`;
  protected readonly keys = signal<ServiceApiKey[] | null>(null);
  protected readonly freshKey = signal<CreatedServiceApiKey | null>(null);
  protected readonly busy = signal(false);
  protected readonly busyId = signal<string | null>(null);
  protected readonly copied = signal<CopiedValue>(null);
  protected readonly error = signal<string | null>(null);

  constructor() {
    this.destroyRef.onDestroy(() => this.clearCopyResetTimer());
    this.reload();
  }

  protected reload(): void {
    this.error.set(null);
    this.auth.listServiceApiKeys().subscribe({
      next: (keys) => this.keys.set(keys),
      error: () => this.error.set('Could not load integration keys.'),
    });
  }

  protected async create(): Promise<void> {
    if (this.busy()) return;
    const name = this.name.trim();
    if (!name) return;

    this.copied.set(null);
    this.clearCopyResetTimer();
    this.busy.set(true);
    this.error.set(null);
    try {
      const created = await this.auth.createServiceApiKey(name, this.expirationDate());
      this.freshKey.set(created);
      this.name = 'SugarMaple';
      await this.refreshAfterMutation();
    } catch {
      this.error.set('Key was not created. Complete the owner passkey check, then try again.');
    } finally {
      this.busy.set(false);
    }
  }

  protected dismissFreshKey(): void {
    this.freshKey.set(null);
    this.copied.set(null);
    this.clearCopyResetTimer();
  }

  protected async revoke(key: ServiceApiKey): Promise<void> {
    if (!confirm(`Revoke "${key.name}"? SugarMaple will stop working with this key.`)) {
      return;
    }

    this.busyId.set(key.keyId);
    this.error.set(null);
    try {
      await this.auth.revokeServiceApiKey(key.keyId);
      await this.refreshAfterMutation();
    } catch {
      this.error.set('Key was not revoked. Complete the owner passkey check, then try again.');
    } finally {
      this.busyId.set(null);
    }
  }

  protected async copy(value: string, kind: Exclude<CopiedValue, null>): Promise<void> {
    this.error.set(null);
    try {
      await navigator.clipboard.writeText(value);
      this.copied.set(kind);
      this.scheduleCopyReset();
    } catch {
      this.error.set('Could not copy automatically. Select the value and copy it manually.');
    }
  }

  protected status(key: ServiceApiKey): 'Active' | 'Expired' | 'Revoked' {
    if (key.revokedAt) return 'Revoked';
    if (key.expiresAt && new Date(key.expiresAt).getTime() <= Date.now()) return 'Expired';
    return 'Active';
  }

  private expirationDate(): string | null {
    if (this.expiry === 'never') return null;
    const expiresAt = new Date();
    expiresAt.setUTCDate(expiresAt.getUTCDate() + Number(this.expiry));
    return expiresAt.toISOString();
  }

  private refreshAfterMutation(): Promise<void> {
    return new Promise((resolve) => {
      this.auth.listServiceApiKeys().subscribe({
        next: (keys) => {
          this.keys.set(keys);
          resolve();
        },
        error: () => {
          this.error.set('The key changed, but the list could not be refreshed.');
          resolve();
        },
      });
    });
  }

  private scheduleCopyReset(): void {
    this.clearCopyResetTimer();
    this.copyResetTimer = setTimeout(() => {
      this.copied.set(null);
      this.copyResetTimer = undefined;
    }, 2_000);
  }

  private clearCopyResetTimer(): void {
    if (this.copyResetTimer === undefined) return;
    clearTimeout(this.copyResetTimer);
    this.copyResetTimer = undefined;
  }
}
