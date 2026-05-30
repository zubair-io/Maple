// ObservabilityComponent — `/settings/observability` (owner-gated).
//
// Surfaces the SigNoz / OpenTelemetry wiring (#713):
//   - a master enable toggle (persisted LOCALLY in this browser — distinct from
//     the server's `enabled` flag, so an operator can opt their own session out
//     without changing the deployment-wide config),
//   - the pulled server config (endpoint, traces/logs toggles, whether an
//     ingestion key is set, with per-field provenance from `source`),
//   - the IndexedDB cache status + last-refresh time,
//   - a "Send test event" button that emits a log record through the live SDK.
//
// All network/persistence lives in `ObservabilityService` + `BunApiBackendService`;
// this file owns DI, signal wiring, and the local toggle.

import {
  ChangeDetectionStrategy,
  Component,
  OnInit,
  computed,
  inject,
  signal,
} from '@angular/core';
import { type ObservabilityConfigResponse, ObservabilityService } from '@maple-common';
import { SettingsShellComponent } from '../settings-shell.component';
import { SettingsIconComponent } from '../settings-icon.component';

/** localStorage key for the per-browser opt-out. Mirrors the `cm.*` namespace
 * the rest of the app uses for client-only preferences. */
const LOCAL_ENABLE_KEY = 'cm.observabilityEnabled';

type TestState =
  | { kind: 'idle' }
  | { kind: 'sending' }
  | { kind: 'sent' }
  | { kind: 'error'; message: string };

@Component({
  selector: 'maple-observability-settings',
  standalone: true,
  imports: [SettingsShellComponent, SettingsIconComponent],
  templateUrl: './observability.component.html',
  styleUrl: './observability.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ObservabilityComponent implements OnInit {
  private readonly observability = inject(ObservabilityService);

  /** Server-resolved config (also the source of truth for the SDK). */
  protected readonly config = this.observability.config;
  protected readonly initialized = this.observability.initialized;
  protected readonly lastError = this.observability.lastError;
  protected readonly cachedAt = this.observability.cachedAt;

  /** Per-browser opt-in (defaults to on). Persisted to localStorage. */
  protected readonly localEnabled = signal<boolean>(this.loadLocalEnabled());

  protected readonly refreshing = signal(false);
  protected readonly testState = signal<TestState>({ kind: 'idle' });

  /** Whether telemetry is actually flowing: server-enabled AND has an endpoint
   * AND this browser hasn't opted out AND the SDK reported it came up. */
  protected readonly active = computed(() => {
    const cfg = this.config();
    return this.localEnabled() && this.initialized() && !!cfg && cfg.enabled && !!cfg.endpoint;
  });

  /** Human "last refreshed" string for the cache line. */
  protected readonly cachedAtLabel = computed(() => {
    const ts = this.cachedAt();
    return ts ? new Date(ts).toLocaleString() : null;
  });

  ngOnInit(): void {
    // Paint with whatever the startup initializer already loaded, then pull a
    // fresh copy so the page reflects server-side edits without a reload.
    void this.observability.refresh();
  }

  protected async onRefresh(): Promise<void> {
    this.refreshing.set(true);
    try {
      await this.observability.refresh();
    } finally {
      this.refreshing.set(false);
    }
  }

  protected toggleLocal(): void {
    const next = !this.localEnabled();
    this.localEnabled.set(next);
    try {
      localStorage.setItem(LOCAL_ENABLE_KEY, JSON.stringify(next));
    } catch {
      /* storage may be unavailable (private mode) — the in-memory signal wins */
    }
  }

  /** Emit a structured test log through the live SDK so the operator can
   * confirm events reach SigNoz end-to-end. */
  protected sendTestEvent(): void {
    if (!this.active()) {
      this.testState.set({
        kind: 'error',
        message: 'Telemetry is inactive — enable it and confirm an endpoint is set.',
      });
      return;
    }
    this.testState.set({ kind: 'sending' });
    try {
      this.observability.recordLog('info', 'Maple web test event', {
        'maple.test_event': true,
        'maple.source': 'settings.observability',
        'maple.emitted_at': new Date().toISOString(),
      });
      this.testState.set({ kind: 'sent' });
      setTimeout(() => {
        this.testState.update((s) => (s.kind === 'sent' ? { kind: 'idle' } : s));
      }, 2500);
    } catch (err) {
      this.testState.set({
        kind: 'error',
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /** True iff the server reports an ingestion key is configured. The key itself
   * IS present in the response (direct-to-SigNoz clients need it for the
   * `signoz-access-token` header) — but this UI never renders the value, only
   * whether one is set. */
  protected keyConfigured(cfg: ObservabilityConfigResponse): boolean {
    return cfg.ingestion_key !== null && cfg.ingestion_key !== '';
  }

  /** Provenance label for a `source` field. */
  protected sourceLabel(kind: string | undefined): string {
    switch (kind) {
      case 'db':
        return 'set in database';
      case 'env':
        return 'from environment';
      case 'unset':
        return 'unset';
      default:
        return kind ?? 'unknown';
    }
  }

  private loadLocalEnabled(): boolean {
    try {
      const s = localStorage.getItem(LOCAL_ENABLE_KEY);
      return s != null ? (JSON.parse(s) as boolean) !== false : true;
    } catch {
      return true;
    }
  }
}
