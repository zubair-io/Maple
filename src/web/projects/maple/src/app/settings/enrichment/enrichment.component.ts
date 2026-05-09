// EnrichmentComponent — `/settings/enrichment` (auth + owner-gated).
//
// Surface for the slow-tier enrichment workers' runtime config:
//   - Nominatim URL (geocode worker dependency)
//   - Geocode-worker enable toggle
//   - "Test connection" button (POSTs /api/enrichment/test without saving)
//   - "Save" button (PUT /api/enrichment/config — server health-checks
//     before persisting, returns 502 on failure)
//
// The server's response includes a `source` field per setting so the UI can
// show whether each value came from the DB row, an env-var fallback, or a
// built-in default.

import {
  ChangeDetectionStrategy,
  Component,
  OnInit,
  inject,
  signal,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import {
  BunApiBackendService,
  type EnrichmentConfigResponse,
} from '@maple-common';

/** Submission state for the Save button — controls disabled/spinner. */
type SaveStatus = 'idle' | 'saving' | 'success' | 'error';

/** State for the Test button — separate so a failing test doesn't block save
 * (the server runs its own health-check on save anyway). */
type TestStatus =
  | { kind: 'idle' }
  | { kind: 'testing' }
  | { kind: 'ok'; url: string }
  | { kind: 'error'; message: string };

@Component({
  standalone: true,
  selector: 'maple-enrichment-settings',
  imports: [RouterLink, FormsModule],
  templateUrl: './enrichment.component.html',
  styleUrl: './enrichment.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class EnrichmentComponent implements OnInit {
  private readonly api = inject(BunApiBackendService);

  /** Last-loaded server response. Populated on init + after a successful save. */
  readonly serverConfig = signal<EnrichmentConfigResponse | null>(null);

  /** Editable form state — `null` URL is rendered as an empty string. */
  readonly url = signal<string>('');
  readonly enabled = signal<boolean>(true);

  readonly loadError = signal<string | null>(null);
  readonly saveError = signal<string | null>(null);
  readonly saveStatus = signal<SaveStatus>('idle');
  readonly testStatus = signal<TestStatus>({ kind: 'idle' });

  ngOnInit(): void {
    this.load();
  }

  load(): void {
    this.loadError.set(null);
    this.api.getEnrichmentConfig().subscribe({
      next: (cfg) => {
        this.serverConfig.set(cfg);
        this.url.set(cfg.nominatim_url ?? '');
        this.enabled.set(cfg.geocode_worker_enabled);
      },
      error: (err) => {
        this.loadError.set(this.errorMessage(err));
      },
    });
  }

  /** Hit /api/enrichment/test with the URL currently in the input — does
   * NOT save. The server response distinguishes 200 OK from a Nominatim
   * 5xx + reports the upstream status code so the user can diagnose. */
  testConnection(): void {
    const url = this.url().trim();
    if (url.length === 0) {
      this.testStatus.set({
        kind: 'error',
        message: 'Enter a URL to test.',
      });
      return;
    }
    this.testStatus.set({ kind: 'testing' });
    this.api.testNominatim(url).subscribe({
      next: (res) => {
        if (res.ok && res.url) {
          this.testStatus.set({ kind: 'ok', url: res.url });
        } else {
          this.testStatus.set({
            kind: 'error',
            message: res.error ?? 'Health check failed',
          });
        }
      },
      error: (err) => {
        this.testStatus.set({ kind: 'error', message: this.errorMessage(err) });
      },
    });
  }

  /** Save then re-apply on the server. The server runs its own health-check
   * before persisting, so a typo is rejected with a 502 (we surface it). */
  save(): void {
    const trimmed = this.url().trim();
    const body = {
      nominatim_url: trimmed.length > 0 ? trimmed : null,
      geocode_worker_enabled: this.enabled(),
    };
    this.saveError.set(null);
    this.saveStatus.set('saving');
    this.api.saveEnrichmentConfig(body).subscribe({
      next: (cfg) => {
        this.serverConfig.set(cfg);
        this.url.set(cfg.nominatim_url ?? '');
        this.enabled.set(cfg.geocode_worker_enabled);
        this.saveStatus.set('success');
        // Clear the success indicator after a moment so the page stays clean.
        setTimeout(() => {
          if (this.saveStatus() === 'success') this.saveStatus.set('idle');
        }, 2_500);
      },
      error: (err) => {
        this.saveError.set(this.errorMessage(err));
        this.saveStatus.set('error');
      },
    });
  }

  /** Map a `source` enum to a short pill label. Pure helper. */
  sourceLabel(
    source: 'db' | 'env' | 'unset' | 'default' | undefined,
  ): { text: string; tone: 'saved' | 'env' | 'default' } {
    switch (source) {
      case 'db':
        return { text: 'saved', tone: 'saved' };
      case 'env':
        return { text: 'env', tone: 'env' };
      case 'unset':
      case 'default':
      default:
        return { text: 'default', tone: 'default' };
    }
  }

  private errorMessage(err: unknown): string {
    if (err && typeof err === 'object' && 'error' in err) {
      const inner = (err as { error?: unknown }).error;
      if (inner && typeof inner === 'object' && 'error' in inner) {
        return String((inner as { error: unknown }).error);
      }
      if (typeof inner === 'string') return inner;
    }
    if (err instanceof Error) return err.message;
    return String(err);
  }
}
