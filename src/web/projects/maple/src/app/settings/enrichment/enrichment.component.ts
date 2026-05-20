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
  /** String input — number parsing happens at save() time. Empty = clear
   * back to env-or-default. */
  readonly rateLimit = signal<string>('');

  // ── Describe worker — Ollama-only, model + prompt are locked server-side.
  readonly describeEnabled = signal<boolean>(true);
  readonly describeUrl = signal<string>('');

  // ── Face worker (Phase 5) ─────────────────────────────────────────
  readonly faceEnabled = signal<boolean>(false);
  readonly faceModelDir = signal<string>('');
  readonly faceRetinafaceUrl = signal<string>('');
  readonly faceRetinafaceSha = signal<string>('');
  readonly faceMobilefacenetUrl = signal<string>('');
  readonly faceMobilefacenetSha = signal<string>('');

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
        this.describeUrl.set(cfg.describe_provider_url ?? '');
        this.faceEnabled.set(cfg.face_worker_enabled);
        this.faceModelDir.set(cfg.face_model_dir);
        this.faceRetinafaceUrl.set(cfg.face_retinaface_url ?? '');
        this.faceRetinafaceSha.set(cfg.face_retinaface_sha256 ?? '');
        this.faceMobilefacenetUrl.set(cfg.face_mobilefacenet_url ?? '');
        this.faceMobilefacenetSha.set(cfg.face_mobilefacenet_sha256 ?? '');
      },
      error: (err) => {
        this.loadError.set(this.errorMessage(err));
      },
    });
  }

  /** Hit /api/enrichment/test-describe with the current Ollama URL — does
   * NOT save. Mirrors `testConnection()` for Nominatim. */
  testDescribe(): void {
    this.describeTestStatus.set({ kind: 'testing' });
    this.api
      .testDescribeProvider({
        provider: 'ollama',
        url: this.describeUrl().trim() || null,
        model: null,
        api_key: null,
      })
      .subscribe({
        next: (res) => {
          if (res.ok) {
            this.describeTestStatus.set({
              kind: 'ok',
              url: this.describeUrl().trim() || 'http://localhost:11434',
            });
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
    const describeUrlTrimmed = this.describeUrl().trim();
    const body = {
      nominatim_url: trimmed.length > 0 ? trimmed : null,
      geocode_worker_enabled: this.enabled(),
      nominatim_rate_limit_per_sec: rate,
      describe_worker_enabled: this.describeEnabled(),
      describe_provider_url:
        describeUrlTrimmed.length > 0 ? describeUrlTrimmed : null,
      face_worker_enabled: this.faceEnabled(),
      // Trim everything; empty string clears the override (resolver falls
      // back to env or default). The model-dir field is special-cased: an
      // empty input is preserved as null so the resolver picks the
      // built-in `~/.maple/models/` default rather than persisting "".
      face_model_dir: this.faceModelDir().trim().length > 0
        ? this.faceModelDir().trim()
        : null,
      face_retinaface_url: this.faceRetinafaceUrl().trim().length > 0
        ? this.faceRetinafaceUrl().trim()
        : null,
      face_retinaface_sha256: this.faceRetinafaceSha().trim().length > 0
        ? this.faceRetinafaceSha().trim()
        : null,
      face_mobilefacenet_url: this.faceMobilefacenetUrl().trim().length > 0
        ? this.faceMobilefacenetUrl().trim()
        : null,
      face_mobilefacenet_sha256: this.faceMobilefacenetSha().trim().length > 0
        ? this.faceMobilefacenetSha().trim()
        : null,
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
        this.describeUrl.set(cfg.describe_provider_url ?? '');
        this.faceEnabled.set(cfg.face_worker_enabled);
        this.faceModelDir.set(cfg.face_model_dir);
        this.faceRetinafaceUrl.set(cfg.face_retinaface_url ?? '');
        this.faceRetinafaceSha.set(cfg.face_retinaface_sha256 ?? '');
        this.faceMobilefacenetUrl.set(cfg.face_mobilefacenet_url ?? '');
        this.faceMobilefacenetSha.set(cfg.face_mobilefacenet_sha256 ?? '');
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

  /** Format a byte count compactly: 13478912 → "12.9 MB". */
  formatBytes(bytes: number | undefined | null): string {
    if (!bytes || bytes <= 0) return '0 B';
    const units = ['B', 'KB', 'MB', 'GB'];
    let v = bytes;
    let i = 0;
    while (v >= 1024 && i < units.length - 1) {
      v /= 1024;
      i++;
    }
    return `${v.toFixed(v < 10 ? 1 : 0)} ${units[i]}`;
  }

  /** Trim long absolute paths to the last two segments so the badge
   * doesn't break the card layout on a deep MAPLE_MODEL_DIR. */
  shortenPath(path: string | undefined | null): string {
    if (!path) return '';
    const parts = path.split('/').filter((p) => p.length > 0);
    if (parts.length <= 2) return path;
    return '…/' + parts.slice(-2).join('/');
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
