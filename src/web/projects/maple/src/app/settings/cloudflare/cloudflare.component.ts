// CloudflareComponent — `/settings/cloudflare` (owner-gated, #1757).
//
// Operator provisioning surface for the Cloudflare R2 thumbnail-mirror:
//   - Enable/disable toggle
//   - R2 credentials (account id, bucket, access key id, secret access key)
//   - A "Test" button that round-trips a probe object through R2 without
//     saving, so a typo surfaces before the operator commits it
//   - A read-only JWT-secret reveal panel: the operator copies the value
//     into `wrangler secret put JWT_SECRET` for the Cloudflare Worker
//     (#1760) that fronts `/api/thumb/*` at the edge
//
// The "Sync existing thumbnails to Cloudflare" backfill trigger is
// deliberately NOT on this page yet — it depends on the backfill job
// landing in #1761. Per the no-placeholder-controls convention, that
// button ships alongside its backend, not before.
//
// Config is DB-only (no env fallback) — same convention as Pano/Observability.

import { ChangeDetectionStrategy, Component, OnInit, effect, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { HttpErrorResponse } from '@angular/common/http';
import { AuthService, CloudflareService, type CloudflareConfig } from '@maple-common';
import { SettingsShellComponent } from '../settings-shell.component';

type SaveState =
  | { kind: 'idle' }
  | { kind: 'saving' }
  | { kind: 'saved' }
  | { kind: 'error'; message: string };

type TestState =
  | { kind: 'idle' }
  | { kind: 'testing' }
  | { kind: 'ok' }
  | { kind: 'error'; message: string };

type JwtSecretState =
  | { kind: 'hidden' }
  | { kind: 'loading' }
  | { kind: 'revealed'; secret: string }
  | { kind: 'error'; message: string };

@Component({
  selector: 'maple-cloudflare-settings',
  standalone: true,
  imports: [FormsModule, SettingsShellComponent],
  templateUrl: './cloudflare.component.html',
  styleUrl: './cloudflare.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class CloudflareComponent implements OnInit {
  private readonly cloudflare = inject(CloudflareService);
  private readonly auth = inject(AuthService);

  protected readonly loading = signal(true);
  protected readonly loadError = signal<string | null>(null);
  protected readonly saveState = signal<SaveState>({ kind: 'idle' });
  protected readonly testState = signal<TestState>({ kind: 'idle' });
  protected readonly jwtSecretState = signal<JwtSecretState>({ kind: 'hidden' });
  protected readonly jwtSecretCopied = signal(false);

  protected readonly config = signal<CloudflareConfig | null>(null);

  // ── Editable form fields ─────────────────────────────────────────────────
  protected readonly fEnabled = signal(false);
  protected readonly fAccountId = signal('');
  protected readonly fBucket = signal('');
  protected readonly fAccessKeyId = signal('');
  protected readonly fSecretAccessKey = signal('');

  private formSeeded = false;

  constructor() {
    // Seed the form the first time the config loads.
    effect(() => {
      const cfg = this.config();
      if (!cfg || this.formSeeded) return;
      this.formSeeded = true;
      this.seedForm(cfg);
    });
  }

  ngOnInit(): void {
    this.cloudflare.getConfig().subscribe({
      next: (cfg) => {
        this.config.set(cfg);
        this.loading.set(false);
      },
      error: (err: HttpErrorResponse) => {
        this.loadError.set(err.error?.error ?? 'Failed to load Cloudflare configuration.');
        this.loading.set(false);
      },
    });
  }

  private seedForm(cfg: CloudflareConfig): void {
    this.fEnabled.set(cfg.enabled);
    this.fAccountId.set(cfg.account_id ?? '');
    this.fBucket.set(cfg.bucket ?? '');
    this.fAccessKeyId.set(cfg.access_key_id ?? '');
    // The secret is never sent to the client — the field starts blank
    // regardless of whether one is already saved (see secretPlaceholder()).
    this.fSecretAccessKey.set('');
  }

  protected secretPlaceholder(): string {
    return this.config()?.secret_access_key_set
      ? '••••••••  (unchanged — leave blank to keep)'
      : '';
  }

  protected save(): void {
    this.saveState.set({ kind: 'saving' });
    const secret = this.fSecretAccessKey().trim();
    this.cloudflare
      .putConfig({
        enabled: this.fEnabled(),
        account_id: this.fAccountId().trim() || null,
        bucket: this.fBucket().trim() || null,
        access_key_id: this.fAccessKeyId().trim() || null,
        ...(secret.length > 0 ? { secret_access_key: secret } : {}),
      })
      .subscribe({
        next: (cfg) => {
          this.config.set(cfg);
          this.formSeeded = false; // allow re-seed from fresh config
          this.saveState.set({ kind: 'saved' });
          setTimeout(() => {
            this.saveState.update((s) => (s.kind === 'saved' ? { kind: 'idle' } : s));
          }, 2000);
        },
        error: (err: HttpErrorResponse) => {
          this.saveState.set({
            kind: 'error',
            message: err.error?.error ?? 'Save failed.',
          });
        },
      });
  }

  /** Test the credentials currently in the form (not necessarily saved).
   * Requires the full set of fields plus a secret — either freshly typed or
   * already saved (the "unchanged" case can't be probed client-side since
   * the secret is never echoed, so we require a fresh value here). */
  protected canTest(): boolean {
    return (
      this.fAccountId().trim().length > 0 &&
      this.fBucket().trim().length > 0 &&
      this.fAccessKeyId().trim().length > 0 &&
      this.fSecretAccessKey().trim().length > 0
    );
  }

  protected test(): void {
    if (!this.canTest()) return;
    this.testState.set({ kind: 'testing' });
    this.cloudflare
      .testCredentials({
        account_id: this.fAccountId().trim(),
        bucket: this.fBucket().trim(),
        access_key_id: this.fAccessKeyId().trim(),
        secret_access_key: this.fSecretAccessKey().trim(),
      })
      .subscribe({
        next: (result) => {
          this.testState.set(
            result.ok ? { kind: 'ok' } : { kind: 'error', message: result.error ?? 'Test failed.' },
          );
        },
        error: (err: HttpErrorResponse) => {
          this.testState.set({
            kind: 'error',
            message: err.error?.error ?? 'Test failed.',
          });
        },
      });
  }

  protected revealJwtSecret(): void {
    this.jwtSecretState.set({ kind: 'loading' });
    this.auth
      .getJwtSecret()
      .then((secret) => this.jwtSecretState.set({ kind: 'revealed', secret }))
      .catch((err: HttpErrorResponse) =>
        this.jwtSecretState.set({
          kind: 'error',
          message: err.error?.error ?? 'Failed to load the JWT secret.',
        }),
      );
  }

  protected hideJwtSecret(): void {
    this.jwtSecretState.set({ kind: 'hidden' });
    this.jwtSecretCopied.set(false);
  }

  protected copyJwtSecret(): void {
    const state = this.jwtSecretState();
    if (state.kind !== 'revealed') return;
    // Clipboard API is unavailable in non-secure contexts / older browsers —
    // same guard as users.component.ts's copyCode().
    if (typeof navigator === 'undefined' || !('clipboard' in navigator)) return;
    void navigator.clipboard.writeText(state.secret).then(() => {
      this.jwtSecretCopied.set(true);
      setTimeout(() => this.jwtSecretCopied.set(false), 2000);
    });
  }
}
