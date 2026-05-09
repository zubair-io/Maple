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
  type DescribeProviderName,
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
  /** String input — number parsing happens at save() time. Empty = clear
   * back to env-or-default. */
  readonly rateLimit = signal<string>('');

  // ── Describe worker (Phase 6) ─────────────────────────────────────
  readonly describeEnabled = signal<boolean>(true);
  readonly describeProvider = signal<DescribeProviderName>('ollama');
  readonly describeUrl = signal<string>('');
  readonly describeModel = signal<string>('');
  readonly describePrompt = signal<string>('');
  readonly describeCap = signal<string>('');
  /** Write-only API-key input. Never round-tripped from the server (the
   * GET /config response doesn't include keys); blank means "leave the
   * existing env / saved key alone." */
  readonly describeApiKey = signal<string>('');

  // ── Face worker (Phase 5) ─────────────────────────────────────────
  readonly faceEnabled = signal<boolean>(false);
  // ── OCR worker (Phase 8) ──────────────────────────────────────────
  readonly ocrEnabled = signal<boolean>(false);

  readonly loadError = signal<string | null>(null);
  readonly saveError = signal<string | null>(null);
  readonly saveStatus = signal<SaveStatus>('idle');
  readonly testStatus = signal<TestStatus>({ kind: 'idle' });
  readonly describeTestStatus = signal<TestStatus>({ kind: 'idle' });

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
        this.rateLimit.set(String(cfg.nominatim_rate_limit_per_sec));
        this.describeEnabled.set(cfg.describe_worker_enabled);
        this.describeProvider.set(cfg.describe_provider);
        this.describeUrl.set(cfg.describe_provider_url ?? '');
        this.describeModel.set(cfg.describe_model);
        this.describePrompt.set(cfg.describe_system_prompt);
        this.describeCap.set(String(cfg.describe_daily_cap_usd));
        // API key is never echoed by the server — clear the field on
        // every load so the operator sees a blank input.
        this.describeApiKey.set('');
        this.faceEnabled.set(cfg.face_worker_enabled);
        this.ocrEnabled.set(cfg.ocr_worker_enabled);
      },
      error: (err) => {
        this.loadError.set(this.errorMessage(err));
      },
    });
  }

  /** True when the currently-selected describe provider needs the URL
   * field. Only Ollama does — paid providers hard-code their endpoint. */
  showsDescribeUrl(): boolean {
    return this.describeProvider() === 'ollama';
  }

  /** True when the provider is paid (i.e. needs an API key). */
  needsDescribeApiKey(): boolean {
    return this.describeProvider() !== 'ollama';
  }

  /** Hit /api/enrichment/test-describe with the current describe form
   * state — does NOT save. Mirrors `testConnection()` for Nominatim. */
  testDescribe(): void {
    this.describeTestStatus.set({ kind: 'testing' });
    const provider = this.describeProvider();
    const apiKey = this.describeApiKey().trim();
    this.api
      .testDescribeProvider({
        provider,
        url: this.describeUrl().trim() || null,
        model: this.describeModel().trim() || null,
        api_key: apiKey.length > 0 ? apiKey : null,
      })
      .subscribe({
        next: (res) => {
          if (res.ok) {
            // The Ollama URL is the most useful "what got reached"
            // signal; for paid providers the endpoint is hard-coded so
            // we just label by provider name.
            const label =
              provider === 'ollama'
                ? this.describeUrl().trim() || 'http://localhost:11434'
                : provider;
            this.describeTestStatus.set({ kind: 'ok', url: label });
          } else {
            this.describeTestStatus.set({
              kind: 'error',
              message: res.error ?? 'Health check failed',
            });
          }
        },
        error: (err) => {
          this.describeTestStatus.set({
            kind: 'error',
            message: this.errorMessage(err),
          });
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
   * before persisting, so a typo is rejected with a 502 (we surface it).
   *
   * Rate-limit handling: an empty input clears the saved value (server
   * falls back to env / default). A non-empty input must parse as a
   * positive number; otherwise we surface a client-side error and skip
   * the request. */
  save(): void {
    const trimmed = this.url().trim();
    const rateInput = this.rateLimit().trim();
    let rate: number | null | undefined;
    if (rateInput.length === 0) {
      rate = null;
    } else {
      const parsed = Number(rateInput);
      if (!Number.isFinite(parsed) || parsed <= 0) {
        this.saveError.set(
          `Rate must be a positive number (got "${rateInput}")`,
        );
        this.saveStatus.set('error');
        return;
      }
      rate = parsed;
    }
    // Validate the describe daily-cap input the same way as the rate
    // limit. Empty clears back to env/default.
    const capInput = this.describeCap().trim();
    let cap: number | null | undefined;
    if (capInput.length === 0) {
      cap = null;
    } else {
      const parsed = Number(capInput);
      if (!Number.isFinite(parsed) || parsed <= 0) {
        this.saveError.set(
          `Daily cap must be a positive number (got "${capInput}")`,
        );
        this.saveStatus.set('error');
        return;
      }
      cap = parsed;
    }

    const promptTrimmed = this.describePrompt().trim();
    const modelTrimmed = this.describeModel().trim();
    const describeUrlTrimmed = this.describeUrl().trim();
    const body = {
      nominatim_url: trimmed.length > 0 ? trimmed : null,
      geocode_worker_enabled: this.enabled(),
      nominatim_rate_limit_per_sec: rate,
      describe_worker_enabled: this.describeEnabled(),
      describe_provider: this.describeProvider(),
      describe_model: modelTrimmed.length > 0 ? modelTrimmed : null,
      describe_system_prompt: promptTrimmed.length > 0 ? promptTrimmed : null,
      describe_daily_cap_usd: cap,
      // Only persist the URL when Ollama is selected; for paid providers
      // it would just be dead weight in the DB row.
      describe_provider_url:
        this.describeProvider() === 'ollama'
          ? describeUrlTrimmed.length > 0
            ? describeUrlTrimmed
            : null
          : undefined,
      face_worker_enabled: this.faceEnabled(),
      ocr_worker_enabled: this.ocrEnabled(),
    };
    this.saveError.set(null);
    this.saveStatus.set('saving');
    this.api.saveEnrichmentConfig(body).subscribe({
      next: (cfg) => {
        this.serverConfig.set(cfg);
        this.url.set(cfg.nominatim_url ?? '');
        this.enabled.set(cfg.geocode_worker_enabled);
        this.rateLimit.set(String(cfg.nominatim_rate_limit_per_sec));
        this.describeEnabled.set(cfg.describe_worker_enabled);
        this.describeProvider.set(cfg.describe_provider);
        this.describeUrl.set(cfg.describe_provider_url ?? '');
        this.describeModel.set(cfg.describe_model);
        this.describePrompt.set(cfg.describe_system_prompt);
        this.describeCap.set(String(cfg.describe_daily_cap_usd));
        this.describeApiKey.set('');
        this.faceEnabled.set(cfg.face_worker_enabled);
        this.ocrEnabled.set(cfg.ocr_worker_enabled);
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
