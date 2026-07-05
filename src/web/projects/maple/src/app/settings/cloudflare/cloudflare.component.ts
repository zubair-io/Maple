// CloudflareComponent — `/settings/cloudflare` (owner-gated, #1757).
//
// Operator provisioning surface for the Cloudflare R2 thumbnail-mirror:
//   - Enable/disable toggle
//   - R2 credentials (account id, bucket, access key id, secret access key)
//   - A "Test" button that round-trips a probe object through R2 without
//     saving, so a typo surfaces before the operator commits it
//
// The JWT secret the Cloudflare Worker (#1760) needs is NOT surfaced here —
// the operator retrieves it directly from the server (MongoDB
// `server_state` collection, `_id: "jwt_secret"`, field `value`; see
// `src/api/src/auth/jwt-secret.repo.ts`) and runs `wrangler secret put
// JWT_SECRET` themselves. The app deliberately has no route that echoes the
// root signing secret — that would add an HTTP-reachable path to what
// otherwise requires actual server access.
//
// A "Sync existing thumbnails" panel (backed by BackfillPanelService) lets
// the operator kick off the `cf_thumb_backfill` job that mirrors every
// already-indexed, not-yet-synced thumbnail to R2, with a progress bar and
// a Cancel control — enabled only once config is complete (see
// `canBackfill()`).
//
// Config is DB-only (no env fallback) — same convention as Pano/Observability.

import {
  ChangeDetectionStrategy,
  Component,
  OnDestroy,
  OnInit,
  effect,
  inject,
  signal,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import { HttpErrorResponse } from '@angular/common/http';
import { CloudflareService, type CloudflareConfig } from '@maple-common';
import { SettingsShellComponent } from '../settings-shell.component';
import { BackfillPanelService } from './backfill-panel.service';

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

@Component({
  selector: 'maple-cloudflare-settings',
  standalone: true,
  imports: [FormsModule, SettingsShellComponent],
  templateUrl: './cloudflare.component.html',
  styleUrl: './cloudflare.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
  providers: [BackfillPanelService],
})
export class CloudflareComponent implements OnInit, OnDestroy {
  private readonly cloudflare = inject(CloudflareService);
  protected readonly backfill = inject(BackfillPanelService);

  protected readonly loading = signal(true);
  protected readonly loadError = signal<string | null>(null);
  protected readonly saveState = signal<SaveState>({ kind: 'idle' });
  protected readonly testState = signal<TestState>({ kind: 'idle' });

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

  ngOnDestroy(): void {
    this.backfill.stopPolling();
  }

  protected secretPlaceholder(): string {
    return this.config()?.secret_access_key_set
      ? '••••••••  (unchanged — leave blank to keep)'
      : '';
  }

  /** The backfill job requires the same completeness the server checks
   * before it'll queue one — surfacing the same gate client-side avoids a
   * round-trip just to learn the button is disabled. */
  protected canBackfill(): boolean {
    const cfg = this.config();
    return (
      !!cfg?.enabled &&
      cfg.secret_access_key_set &&
      !!cfg.account_id &&
      !!cfg.bucket &&
      !!cfg.access_key_id
    );
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
}
