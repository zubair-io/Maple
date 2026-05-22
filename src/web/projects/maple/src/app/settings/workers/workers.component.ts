// WorkersComponent — `/settings/workers` (owner-gated).
//
// Combined Workers + Enrichment surface per the v0.2 spec. One row per
// pipeline stage, grouped Ingest / Enrich / Index. Clicking a row reveals
// an inline panel with the generic stage runtime config (concurrency,
// poll, batch, max-attempts) plus, for enrichment stages, the domain
// config (Ollama URL + model, Nominatim URL + rate, face model dir +
// download URLs). Pause replaces the old "Enable" checkbox; the spec
// makes paused and disabled the same state.
//
// Two data sources are merged here:
//   - WorkersApiService.getStatus() polls /api/workers/status for live
//     status / counters / per-stage config.
//   - BunApiBackendService.getEnrichmentConfig() supplies the domain
//     config for describe/geocode/face stages plus the live face-model
//     loader banner.
//
// All pure logic (stage metadata, grouping, summarisation, formatting,
// form defaults, error normalisation, clamped int parsing) lives in
// `./workers.vm.ts`. This file owns DI, signal wiring, and side effects.

import {
  ChangeDetectionStrategy,
  Component,
  OnDestroy,
  OnInit,
  computed,
  inject,
  signal,
} from '@angular/core';
import { DecimalPipe } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { type Subscription } from 'rxjs';
import {
  BunApiBackendService,
  type EnrichmentConfigResponse,
  WorkersApiService,
  type StageStatus,
  type WorkersStatusResponse,
} from '@maple-common';
import { SettingsShellComponent } from '../settings-shell.component';
import { SettingsIconComponent } from '../settings-icon.component';
import {
  ERROR_POLL_MS,
  FIXED_DESCRIBE_MODEL,
  POLL_MS,
  STAGE_META,
  blankEnrichment,
  blankRuntime,
  errorMessage,
  formatBytes,
  groupStagesByPipeline,
  runtimeFormToPatch,
  stageMeta,
  statusDotColor,
  statusLabel,
  summarizeStages,
  throughputLabel,
  type EnrichmentForm,
  type EnrichmentKind,
  type RuntimeForm,
  type SaveState,
  type StageGroup,
  type StageMeta,
} from './workers.vm';

@Component({
  selector: 'maple-workers-settings',
  standalone: true,
  imports: [DecimalPipe, FormsModule, SettingsShellComponent, SettingsIconComponent],
  templateUrl: './workers.component.html',
  styleUrl: './workers.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class WorkersComponent implements OnInit, OnDestroy {
  protected readonly fixedDescribeModel = FIXED_DESCRIBE_MODEL;

  private readonly api = inject(WorkersApiService);
  private readonly enrichmentApi = inject(BunApiBackendService);

  protected readonly status = signal<WorkersStatusResponse | null>(null);
  protected readonly error = signal<string | null>(null);
  protected readonly expanded = signal<Record<string, boolean>>({});
  protected readonly enrichmentConfig = signal<EnrichmentConfigResponse | null>(null);
  /** Tracks whether `GET /enrichment/config` failed. Used together with
   * `enrichmentConfig === null` to distinguish "still loading" from
   * "load errored" so the save button can stay safely disabled in both
   * cases but the operator gets the right hint. */
  protected readonly enrichmentConfigError = signal<string | null>(null);

  // Per-stage form state — keyed by stage id. Empty until the row expands.
  protected readonly runtimeForms = signal<Record<string, RuntimeForm>>({});
  protected readonly enrichmentForms = signal<Record<string, EnrichmentForm>>({});

  protected readonly saveStates = signal<Record<string, SaveState>>({});
  protected readonly saveErrors = signal<Record<string, string | null>>({});

  /** "Test connection" state for the URL field in describe/geocode rows.
   * Keyed by stage id so each row tracks its own probe independently. */
  protected readonly testStates = signal<
    Record<
      string,
      { kind: 'idle' } | { kind: 'testing' } | { kind: 'ok' } | { kind: 'error'; message: string }
    >
  >({});

  protected readonly stages = computed<StageStatus[]>(() => this.status()?.stages ?? []);

  /** Stages grouped + sorted in pipeline order. */
  protected readonly groupedStages = computed<
    readonly { group: StageGroup; rows: StageStatus[] }[]
  >(() => groupStagesByPipeline(this.stages()));

  protected readonly summary = computed(() => summarizeStages(this.stages()));

  private pollSub: Subscription | null = null;
  private pollTimer: ReturnType<typeof setTimeout> | null = null;
  private destroyed = false;

  ngOnInit(): void {
    this.fetchStatus();
    this.fetchEnrichmentConfig();
  }

  /** Pulls the enrichment config that seeds the describe/geocode/face
   * row forms and gates the Save button on those rows. The Ingest runtime
   * rows don't depend on this config and remain savable regardless of its
   * load state. Stored as a method so {@link retryEnrichmentConfig} can
   * re-arm the button after a transient failure without a page reload. */
  private fetchEnrichmentConfig(): void {
    this.enrichmentConfigError.set(null);
    this.enrichmentApi.getEnrichmentConfig().subscribe({
      next: (cfg) => this.enrichmentConfig.set(cfg),
      error: (err: unknown) => this.enrichmentConfigError.set(errorMessage(err)),
    });
  }

  /** Retry handler exposed to the template — re-runs the enrichment
   * config GET so the operator can re-enable save without a page reload
   * after a transient API hiccup. */
  protected retryEnrichmentConfig(): void {
    this.fetchEnrichmentConfig();
  }

  ngOnDestroy(): void {
    this.destroyed = true;
    if (this.pollTimer) {
      clearTimeout(this.pollTimer);
      this.pollTimer = null;
    }
    this.pollSub?.unsubscribe();
    this.pollSub = null;
  }

  private fetchStatus(): void {
    if (this.destroyed) return;
    this.pollSub = this.api.getStatus().subscribe({
      next: (data) => {
        this.status.set(data);
        this.error.set(null);
        this.scheduleNextPoll(POLL_MS);
      },
      error: (err) => {
        this.error.set(errorMessage(err) ?? 'Failed to load worker status.');
        this.scheduleNextPoll(ERROR_POLL_MS);
      },
    });
  }

  private scheduleNextPoll(delay: number): void {
    if (this.destroyed) return;
    this.pollTimer = setTimeout(() => this.fetchStatus(), delay);
  }

  // ── Row interactions ────────────────────────────────────────────────────

  toggleExpanded(stage: StageStatus): void {
    const next = !(this.expanded()[stage.name] ?? false);
    this.expanded.update((cur) => ({ ...cur, [stage.name]: next }));
    if (next) {
      this.ensureForm(stage);
    }
  }

  isExpanded(stage: StageStatus): boolean {
    return this.expanded()[stage.name] ?? false;
  }

  togglePause(stage: StageStatus, event: Event): void {
    event.stopPropagation();
    const next: StageStatus['status'] = stage.status === 'paused' ? 'running' : 'paused';
    this.setLocalStatus(stage.name, next);
    const obs =
      stage.status === 'paused' ? this.api.resume(stage.name) : this.api.pause(stage.name);
    obs.subscribe({
      next: () => {
        /* next poll will sync */
      },
      error: () => this.setLocalStatus(stage.name, stage.status),
    });
  }

  retryDead(stage: StageStatus, event: Event): void {
    event.stopPropagation();
    this.api.retryDead(stage.name).subscribe({
      next: () => {
        /* poll syncs */
      },
    });
  }

  /** Probe the URL currently typed into the describe/geocode panel —
   * does NOT save. The server's health-check on save is still the
   * authoritative gate; this is a convenience for the operator. */
  testConnection(stage: StageStatus): void {
    const meta = STAGE_META[stage.name];
    if (!meta?.enrichment) return;
    const form = this.enrichmentForms()[stage.name];
    if (!form) return;
    this.testStates.update((cur) => ({ ...cur, [stage.name]: { kind: 'testing' } }));
    const finishOk = () =>
      this.testStates.update((cur) => ({ ...cur, [stage.name]: { kind: 'ok' } }));
    const finishErr = (err: unknown) =>
      this.testStates.update((cur) => ({
        ...cur,
        [stage.name]: { kind: 'error', message: errorMessage(err) },
      }));

    if (meta.enrichment === 'geocode') {
      const url = form.nominatim_url.trim();
      if (url.length === 0) {
        finishErr(new Error('Enter a URL to test.'));
        return;
      }
      this.enrichmentApi.testNominatim(url).subscribe({
        next: (res) =>
          res.ok ? finishOk() : finishErr(new Error(res.error ?? 'Health check failed')),
        error: finishErr,
      });
    } else if (meta.enrichment === 'describe') {
      this.enrichmentApi
        .testDescribeProvider({
          provider: 'ollama',
          url: form.describe_provider_url.trim() || null,
          // Locked at runtime — pass the fixed model so the probe reflects
          // what the worker actually pulls.
          model: FIXED_DESCRIBE_MODEL,
          api_key: null,
        })
        .subscribe({
          next: (res) =>
            res.ok ? finishOk() : finishErr(new Error(res.error ?? 'Health check failed')),
          error: finishErr,
        });
    }
  }

  testState(stage: StageStatus) {
    return this.testStates()[stage.name] ?? { kind: 'idle' as const };
  }

  /** Lazy: seed form values the first time a row expands. */
  private ensureForm(stage: StageStatus): void {
    if (!this.runtimeForms()[stage.name]) {
      this.runtimeForms.update((cur) => ({
        ...cur,
        [stage.name]: blankRuntime(stage),
      }));
    }
    const meta = STAGE_META[stage.name];
    if (meta?.enrichment && !this.enrichmentForms()[stage.name]) {
      this.enrichmentForms.update((cur) => ({
        ...cur,
        [stage.name]: blankEnrichment(this.enrichmentConfig()),
      }));
    }
  }

  resetForm(stage: StageStatus): void {
    this.runtimeForms.update((cur) => {
      const next = { ...cur };
      delete next[stage.name];
      return next;
    });
    this.enrichmentForms.update((cur) => {
      const next = { ...cur };
      delete next[stage.name];
      return next;
    });
    this.saveStates.update((cur) => ({ ...cur, [stage.name]: 'idle' }));
    this.ensureForm(stage);
  }

  saveStage(stage: StageStatus): void {
    const form = this.runtimeForms()[stage.name];
    if (!form) return;
    const patch = runtimeFormToPatch(form);
    this.saveStates.update((cur) => ({ ...cur, [stage.name]: 'saving' }));
    this.saveErrors.update((cur) => ({ ...cur, [stage.name]: null }));

    const meta = STAGE_META[stage.name];
    const finishOk = () => {
      this.saveStates.update((cur) => ({ ...cur, [stage.name]: 'success' }));
      setTimeout(() => {
        this.saveStates.update((cur) =>
          cur[stage.name] === 'success' ? { ...cur, [stage.name]: 'idle' } : cur,
        );
      }, 1500);
    };
    const finishErr = (err: unknown) => {
      this.saveStates.update((cur) => ({ ...cur, [stage.name]: 'error' }));
      this.saveErrors.update((cur) => ({ ...cur, [stage.name]: errorMessage(err) }));
    };

    this.api.patchConfig(stage.name, patch).subscribe({
      next: () => {
        if (meta?.enrichment) {
          // Roll enrichment-form changes into the same save.
          this.saveEnrichment(stage, meta.enrichment, finishOk, finishErr);
        } else {
          finishOk();
        }
      },
      error: finishErr,
    });
  }

  private saveEnrichment(
    stage: StageStatus,
    kind: EnrichmentKind,
    onOk: () => void,
    onErr: (err: unknown) => void,
  ): void {
    const form = this.enrichmentForms()[stage.name];
    if (!form) {
      onOk();
      return;
    }
    // The save endpoint is whole-config PUT — any field we omit OR set to
    // null gets cleared server-side. Seed the body from the latest server
    // config so editing the describe row doesn't accidentally wipe the
    // Nominatim URL (or vice versa). Then mutate only the fields owned by
    // the row the user is saving.
    //
    // Bail if the seed hasn't arrived — without it we'd clobber every
    // unrelated field on the server. The template guards the Save button
    // against this via `saveDisabled()`, so reaching here means a
    // programmatic call slipped past the gate.
    const current = this.enrichmentConfig();
    if (!current) {
      onErr(
        new Error('Enrichment config not loaded — refusing to save (would clobber other fields).'),
      );
      return;
    }
    const body: Parameters<BunApiBackendService['saveEnrichmentConfig']>[0] = {
      nominatim_url: current.nominatim_url,
      geocode_worker_enabled: current.geocode_worker_enabled,
    };
    if (kind === 'describe') {
      body.describe_provider_url = form.describe_provider_url.trim() || null;
      // describe_model is intentionally omitted — the runtime hardcodes
      // qwen2.5-VL (see FIXED_DESCRIBE_MODEL in workers.vm.ts), so
      // anything we'd send is dropped server-side.
    } else if (kind === 'geocode') {
      body.nominatim_url = form.nominatim_url.trim() || null;
      const rate = Number(form.nominatim_rate_limit_per_sec.trim());
      body.nominatim_rate_limit_per_sec = Number.isFinite(rate) && rate > 0 ? rate : null;
    } else if (kind === 'face') {
      body.face_model_dir = form.face_model_dir.trim() || null;
      body.face_retinaface_url = form.face_retinaface_url.trim() || null;
      body.face_retinaface_sha256 = form.face_retinaface_sha256.trim() || null;
      body.face_mobilefacenet_url = form.face_mobilefacenet_url.trim() || null;
      body.face_mobilefacenet_sha256 = form.face_mobilefacenet_sha256.trim() || null;
    }
    this.enrichmentApi.saveEnrichmentConfig(body).subscribe({
      next: (cfg) => {
        this.enrichmentConfig.set(cfg);
        onOk();
      },
      error: onErr,
    });
  }

  // ── Form bindings (the template binds via these so changes survive
  //    polls that overwrite stage.config). ──────────────────────────────

  runtimeValue(stage: StageStatus, field: keyof RuntimeForm): string {
    return this.runtimeForms()[stage.name]?.[field] ?? '';
  }
  setRuntime(stage: StageStatus, field: keyof RuntimeForm, value: string): void {
    this.runtimeForms.update((cur) => {
      const cur1 = cur[stage.name] ?? blankRuntime(stage);
      return { ...cur, [stage.name]: { ...cur1, [field]: value } };
    });
  }
  enrichmentValue(stage: StageStatus, field: keyof EnrichmentForm): string {
    return this.enrichmentForms()[stage.name]?.[field] ?? '';
  }
  setEnrichment(stage: StageStatus, field: keyof EnrichmentForm, value: string): void {
    this.enrichmentForms.update((cur) => {
      const cur1 = cur[stage.name] ?? blankEnrichment(this.enrichmentConfig());
      return { ...cur, [stage.name]: { ...cur1, [field]: value } };
    });
  }

  // ── Display helpers (thin re-exports so the template keeps reading
  //    `meta(s)` / `statusLabel(s)` / etc.). ────────────────────────────

  meta(stage: StageStatus): StageMeta {
    return stageMeta(stage.name);
  }
  statusLabel = statusLabel;
  statusDotColor = statusDotColor;
  throughputLabel = throughputLabel;
  formatBytes = formatBytes;

  saveState(s: StageStatus): SaveState {
    return this.saveStates()[s.name] ?? 'idle';
  }
  saveError(s: StageStatus): string | null {
    return this.saveErrors()[s.name] ?? null;
  }

  /** Save button disabled when:
   *   - a save is in flight (`saving`), OR
   *   - this row writes enrichment config but that config hasn't been
   *     fetched yet (initial GET pending) or failed (`null` either way).
   * Without the second guard, saving would PUT a body seeded from
   * fallback defaults and clobber every unrelated operator setting on
   * the server. The Ingest rows (no `enrichment` kind) are never blocked
   * by config load. */
  saveDisabled(s: StageStatus): boolean {
    if (this.saveState(s) === 'saving') return true;
    const meta = STAGE_META[s.name];
    if (meta?.enrichment && !this.enrichmentConfig()) return true;
    return false;
  }

  /** Operator-facing reason rendered next to the disabled save button.
   * Only emitted for the enrichment-config-load case — the in-flight
   * `saving` case is communicated by the button label flipping to
   * "Saving…", so it doesn't need a sibling hint. */
  saveDisabledReason(s: StageStatus): string | null {
    const meta = STAGE_META[s.name];
    if (!meta?.enrichment || this.enrichmentConfig()) return null;
    const err = this.enrichmentConfigError();
    return err ? `Enrichment config failed to load: ${err}` : 'Loading enrichment config…';
  }

  private setLocalStatus(name: string, status: StageStatus['status']): void {
    this.status.update((cur) => {
      if (!cur) return cur;
      return { stages: cur.stages.map((s) => (s.name === name ? { ...s, status } : s)) };
    });
  }
}
