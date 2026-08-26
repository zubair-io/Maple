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
  effect,
  inject,
  signal,
} from '@angular/core';
import {
  type ObservabilityConfigPatch,
  type ObservabilityConfigResponse,
  ObservabilityService,
  TypedStorage,
  STORAGE_KEYS,
  errorMessage,
  MuiButtonComponent,
  MuiCheckboxComponent,
  MuiInputComponent,
} from '@maple-common';
import { SettingsShellComponent } from '../settings-shell.component';
import { SettingsIconComponent } from '../settings-icon.component';

type TestState =
  | { kind: 'idle' }
  | { kind: 'sending' }
  | { kind: 'sent' }
  | { kind: 'error'; message: string };

type SaveState =
  | { kind: 'idle' }
  | { kind: 'saving' }
  | { kind: 'saved' }
  | { kind: 'error'; message: string };

type ConnState =
  | { kind: 'idle' }
  | { kind: 'testing' }
  | { kind: 'ok' }
  | { kind: 'error'; message: string };

@Component({
  selector: 'maple-observability-settings',
  standalone: true,
  imports: [
    SettingsShellComponent,
    SettingsIconComponent,
    MuiButtonComponent,
    MuiCheckboxComponent,
    MuiInputComponent,
  ],
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

  // ── Editable server config form ─────────────────────────────────────────
  // The endpoint + key + toggles live server-side (DB only). This form writes
  // them via PUT /api/observability/config; the page is reachable by signed-in
  // users and gated to owners by the settings nav.
  protected readonly fEnabled = signal(true);
  protected readonly fEndpoint = signal('');
  protected readonly fKey = signal('');
  protected readonly fNamespace = signal('');
  protected readonly fTraces = signal(true);
  protected readonly fLogs = signal(true);
  protected readonly fMetrics = signal(false);
  protected readonly fRatio = signal('1');
  /** Seed the form from the server config exactly once (first load); later
   * background refreshes must not clobber an in-progress edit. */
  private formSeeded = false;
  protected readonly saveState = signal<SaveState>({ kind: 'idle' });
  protected readonly connState = signal<ConnState>({ kind: 'idle' });

  constructor() {
    // Seed the form the first time the server config lands.
    effect(() => {
      const cfg = this.config();
      if (!cfg || this.formSeeded) return;
      this.formSeeded = true;
      this.seedForm(cfg);
    });
  }

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
    TypedStorage.set(STORAGE_KEYS.OBSERVABILITY_ENABLED, next);
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
        message: errorMessage(err),
      });
    }
  }

  /** Copy server config values into the editable form fields. The key field is
   * left blank — it's write-only; the placeholder shows whether one is set. */
  private seedForm(cfg: ObservabilityConfigResponse): void {
    this.fEnabled.set(cfg.enabled);
    this.fEndpoint.set(cfg.endpoint ?? '');
    this.fNamespace.set(cfg.service_namespace);
    this.fTraces.set(cfg.traces_enabled);
    this.fLogs.set(cfg.logs_enabled);
    this.fMetrics.set(cfg.metrics_enabled);
    this.fRatio.set(String(cfg.sample_ratio));
    this.fKey.set('');
  }

  /** Persist the form to the server, then reseed from the re-resolved config so
   * the inputs reflect server-side normalisation (e.g. trailing-slash strip). */
  protected async save(): Promise<void> {
    const ratio = Number(this.fRatio().trim());
    if (!Number.isFinite(ratio) || ratio < 0 || ratio > 1) {
      this.saveState.set({
        kind: 'error',
        message: 'Sample ratio must be a number between 0 and 1.',
      });
      return;
    }
    const endpoint = this.fEndpoint().trim();
    const patch: ObservabilityConfigPatch = {
      enabled: this.fEnabled(),
      endpoint: endpoint.length > 0 ? endpoint : null,
      service_namespace: this.fNamespace().trim() || null,
      traces_enabled: this.fTraces(),
      logs_enabled: this.fLogs(),
      metrics_enabled: this.fMetrics(),
      sample_ratio: ratio,
    };
    // Write-only key: only send it when the operator typed one. A blank field
    // leaves the saved key untouched (it's never shown, so blank must not wipe).
    const key = this.fKey().trim();
    if (key.length > 0) patch.ingestion_key = key;

    this.saveState.set({ kind: 'saving' });
    try {
      const fresh = await this.observability.saveConfig(patch);
      this.seedForm(fresh);
      this.saveState.set({ kind: 'saved' });
      setTimeout(() => {
        this.saveState.update((s) => (s.kind === 'saved' ? { kind: 'idle' } : s));
      }, 2000);
    } catch (err) {
      this.saveState.set({
        kind: 'error',
        message: errorMessage(err),
      });
    }
  }

  /** Probe the typed endpoint (+ key) without saving. */
  protected async testConnection(): Promise<void> {
    const endpoint = this.fEndpoint().trim();
    if (endpoint.length === 0) {
      this.connState.set({ kind: 'error', message: 'Enter an endpoint to test.' });
      return;
    }
    this.connState.set({ kind: 'testing' });
    try {
      const res = await this.observability.testConnection(endpoint, this.fKey().trim() || null);
      this.connState.set(
        res.ok ? { kind: 'ok' } : { kind: 'error', message: res.error ?? 'Connection failed.' },
      );
    } catch (err) {
      this.connState.set({
        kind: 'error',
        message: errorMessage(err),
      });
    }
  }

  /** True iff the server reports an ingestion key is configured. The key value
   * is never sent to the client (the OTLP proxy injects it server-side); the
   * response carries only this boolean. */
  protected keyConfigured(cfg: ObservabilityConfigResponse): boolean {
    return cfg.ingestion_key_set;
  }

  /** Placeholder for the write-only key input — tells the operator whether a
   * key is already saved (so a blank field means "keep it"). */
  protected keyPlaceholder(): string {
    const cfg = this.config();
    return cfg && this.keyConfigured(cfg) ? 'configured — leave blank to keep' : 'none';
  }

  /** Provenance label for a `source` field. Config is DB-only, so a value is
   * either saved in the database, a built-in default, or unset. */
  protected sourceLabel(kind: string | undefined): string {
    switch (kind) {
      case 'db':
        return 'saved';
      case 'default':
        return 'default';
      case 'unset':
        return 'unset';
      default:
        return kind ?? 'unknown';
    }
  }

  private loadLocalEnabled(): boolean {
    const stored = TypedStorage.get<boolean>(STORAGE_KEYS.OBSERVABILITY_ENABLED);
    return stored != null ? stored !== false : true;
  }
}
