import { DatePipe } from '@angular/common';
import { ChangeDetectionStrategy, Component, DestroyRef, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import {
  AuthService,
  MuiButtonComponent,
  MuiInputComponent,
  type CreatedServiceApiKey,
  type ServiceApiKey,
  type ServiceApiScope,
} from '@maple-common';
import { SettingsIconComponent } from '../settings-icon.component';

type ExpiryChoice = '30' | '90' | '365' | 'never';
type CopiedValue = 'endpoint' | 'key' | null;

interface ScopeOption {
  scope: ServiceApiScope;
  label: string;
  hint: string;
}

const SCOPE_OPTIONS: readonly ScopeOption[] = [
  {
    scope: 'assets:search',
    label: 'Search photos',
    hint: 'Find photos by text, people, place or date',
  },
  { scope: 'assets:read', label: 'Read photos', hint: 'Photo details, thumbnails and previews' },
  { scope: 'people:read', label: 'List people', hint: 'Names of the people in your photos' },
];

@Component({
  selector: 'maple-service-api-keys',
  standalone: true,
  imports: [DatePipe, FormsModule, SettingsIconComponent, MuiButtonComponent, MuiInputComponent],
  templateUrl: './service-api-keys.component.html',
  host: {
    class: 'set-vars block mt-5.5 pt-5 border-t-[0.5px] border-t-[var(--s-border)] bg-transparent',
  },
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ServiceApiKeysComponent {
  private readonly auth = inject(AuthService);
  private readonly destroyRef = inject(DestroyRef);
  private copyResetTimer: ReturnType<typeof setTimeout> | undefined;

  protected name = 'SugarMaple';
  protected expiry: ExpiryChoice = '90';
  protected readonly endpoint = `${globalThis.location?.origin ?? ''}/api/search/assets`;
  protected readonly scopeOptions = SCOPE_OPTIONS;
  protected readonly scopes = signal<ReadonlySet<ServiceApiScope>>(new Set(['assets:search']));
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
    const scopes = SCOPE_OPTIONS.map((option) => option.scope).filter((scope) =>
      this.scopes().has(scope),
    );
    if (!name || scopes.length === 0) return;

    this.copied.set(null);
    this.clearCopyResetTimer();
    this.busy.set(true);
    this.error.set(null);
    try {
      const created = await this.auth.createServiceApiKey(name, this.expirationDate(), scopes);
      this.freshKey.set(created);
      this.name = 'SugarMaple';
      await this.refreshAfterMutation();
    } catch {
      this.error.set('Key was not created. Complete the owner passkey check, then try again.');
    } finally {
      this.busy.set(false);
    }
  }

  protected toggleScope(scope: ServiceApiScope, checked: boolean): void {
    const next = new Set(this.scopes());
    if (checked) next.add(scope);
    else next.delete(scope);
    this.scopes.set(next);
  }

  protected scopeLabels(key: ServiceApiKey): string {
    return SCOPE_OPTIONS.filter((option) => key.scopes.includes(option.scope))
      .map((option) => option.label.toLowerCase())
      .join(', ');
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

  /** Classes for the key-status pill — one mutually-exclusive computed string
   * per #3071's variant-class rule (Active/Expired/Revoked share the same
   * "color" property) rather than three conditional add-on classes. */
  protected statusPillClasses(status: 'Active' | 'Expired' | 'Revoked'): string {
    const base =
      'py-0.5 px-1.5 rounded-full bg-[var(--s-surface3)] text-[9.5px] font-semibold tracking-[0.06em] uppercase';
    if (status === 'Active') return `${base} bg-[rgba(74,222,128,0.1)] text-[var(--s-ok)]`;
    if (status === 'Expired' || status === 'Revoked') return `${base} text-[var(--s-text-dim)]`;
    return `${base} text-[var(--s-text-muted)]`;
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
