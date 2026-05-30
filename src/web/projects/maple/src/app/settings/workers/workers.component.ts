// WorkersComponent — `/settings/workers` (owner-gated).
//
// Combined Workers + Enrichment surface per the v0.2 spec. One row per
// pipeline stage, grouped Ingest / Enrich / Index. Clicking a row reveals
// an inline panel with the generic stage runtime config (concurrency,
// max-attempts) plus, for enrichment stages, the domain
// config (Ollama URL + model, Nominatim URL + rate, face model dir +
// download URLs). Pause replaces the old "Enable" checkbox; the spec
// makes paused and disabled the same state.
//
// Two data sources are merged here:
//   - WorkerEventsService.workersStatus$ streams live status / counters /
//     per-stage config over the /api/events WS bridge (#674). A one-shot
//     WorkersApiService.getStatus() paints the page before the WS handshake
//     and serves as a non-WS fallback.
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
  HostListener,
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
  type DamagedDoc,
  type DeadDoc,
  type EnrichmentConfigResponse,
  WorkerEventsService,
  WorkersApiService,
  type StageStatus,
  type WorkersStatusResponse,
} from '@maple-common';
import { SettingsShellComponent } from '../settings-shell.component';
import { SettingsIconComponent } from '../settings-icon.component';
import {
  FIXED_DESCRIBE_MODEL,
  STAGE_META,
  blankEnrichment,
  blankRuntime,
  errorMessage,
  formatBytes,
  formatDate,
  groupStagesByPipeline,
  pendingTitle,
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
  private readonly events = inject(WorkerEventsService);
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

  protected readonly deadLog = signal<{
    stage: StageStatus;
    items: DeadDoc[];
    loading: boolean;
    error: string | null;
  } | null>(null);

  /** Damaged-files drawer (the "Damaged" pill opens it). Null when closed.
   * `clearing` gates the per-row + "clear all" buttons against double-submit. */
  protected readonly damagedLog = signal<{
    items: DamagedDoc[];
    loading: boolean;
    error: string | null;
    clearing: boolean;
  } | null>(null);

  /** "Test connection" state for the URL field in describe/geocode rows.
   * Keyed by stage id so each row tracks its own probe independently. */
  protected readonly testStates = signal<
    Record<
      string,
      { kind: 'idle' } | { kind: 'testing' } | { kind: 'ok' } | { kind: 'error'; message: string }
    >
  >({});

  // Missing-reaper prune window (hours). Separate from the generic per-stage
  // runtime config — it's a reaper-only setting persisted via its own route.
  protected readonly reaperPruneWindow = signal<string>('');
  protected readonly reaperPruneLoaded = signal<boolean>(false);
  protected readonly reaperPruneSaveState = signal<SaveState>('idle');
  protected readonly reaperPruneError = signal<string | null>(null);

  protected readonly stages = computed<StageStatus[]>(() => this.status()?.stages ?? []);

  /** Stages grouped + sorted in pipeline order. */
  protected readonly groupedStages = computed<
    readonly { group: StageGroup; rows: StageStatus[] }[]
  >(() => groupStagesByPipeline(this.stages()));

  protected readonly summary = computed(() => summarizeStages(this.stages()));

  /** Collection-level damaged count (not per-stage), straight off the status
   * frame. Drives the "Damaged" pill. */
  protected readonly damagedCount = computed(() => this.status()?.damaged ?? 0);

  private statusSub: Subscription | null = null;
  private fallbackSub: Subscription | null = null;
  private destroyed = false;
  /** Set once the WS stream delivers its first *counted* frame, so the
   * one-shot HTTP fallback never clobbers live WS data with a slower in-flight
   * response. Gated on `counted` so the cheap registry-only snapshot pushed on
   * connect (zeroed counts, `config:null`) does NOT disable the fallback — that
   * fallback carries the real counts + per-stage config that seed the forms. */
  private gotWsFrame = false;

  ngOnInit(): void {
    this.subscribeStatus();
    this.fetchStatusFallback();
    this.fetchEnrichmentConfig();
    this.fetchReaperPruneWindow();
  }

  private fetchReaperPruneWindow(): void {
    this.api.getReaperPruneWindow().subscribe({
      next: ({ hours }) => {
        this.reaperPruneWindow.set(String(hours));
        this.reaperPruneLoaded.set(true);
      },
      error: (err: unknown) => this.reaperPruneError.set(errorMessage(err)),
    });
  }

  /** Template binding for the prune-window input (routes through a method to
   * match the house pattern, e.g. setRuntime). */
  protected setReaperPruneWindow(value: string): void {
    this.reaperPruneWindow.set(value);
  }

  protected saveReaperPruneWindow(): void {
    const hours = Number(this.reaperPruneWindow().trim());
    if (!Number.isFinite(hours) || hours < 1) {
      this.reaperPruneError.set('Enter a whole number of hours (≥ 1).');
      return;
    }
    this.reaperPruneSaveState.set('saving');
    this.reaperPruneError.set(null);
    this.api.setReaperPruneWindow(Math.round(hours)).subscribe({
      next: ({ hours: saved }) => {
        this.reaperPruneWindow.set(String(saved));
        this.reaperPruneSaveState.set('success');
        setTimeout(() => {
          if (this.reaperPruneSaveState() === 'success') this.reaperPruneSaveState.set('idle');
        }, 1500);
      },
      error: (err: unknown) => {
        this.reaperPruneSaveState.set('error');
        this.reaperPruneError.set(errorMessage(err));
      },
    });
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
    this.statusSub?.unsubscribe();
    this.statusSub = null;
    this.fallbackSub?.unsubscribe();
    this.fallbackSub = null;
  }

  /** Live status comes from the `/api/events` WS stream (#674) — the server
   * pushes a `workers-status` frame instead of the page polling
   * `GET /workers/status` every ~2s. */
  private subscribeStatus(): void {
    if (this.destroyed) return;
    this.statusSub = this.events.workersStatus$.subscribe({
      next: ({ status, counted }) => {
        // Always paint the latest frame, but only a counted frame (real
        // DB-derived counts + per-stage config) is authoritative enough to
        // suppress the HTTP fallback. A registry-only snapshot would otherwise
        // set `gotWsFrame` and let the cheap zeroed/`config:null` data win.
        if (counted) this.gotWsFrame = true;
        this.status.set(status);
        this.error.set(null);
      },
      error: (err) => {
        this.error.set(errorMessage(err) ?? 'Failed to load worker status.');
      },
    });
  }

  /** One-shot HTTP fetch so the page paints immediately even before the WS
   * handshake completes (and as a fallback for non-WS clients). Skipped once a
   * WS frame has already landed so it can't overwrite fresher live data. */
  private fetchStatusFallback(): void {
    if (this.destroyed) return;
    this.fallbackSub = this.api.getStatus().subscribe({
      next: (data) => {
        if (this.gotWsFrame || this.destroyed) return;
        this.status.set(data);
      },
      error: () => {
        /* WS is the primary source; ignore the fallback's failure. */
      },
    });
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

  openLogs(stage: StageStatus, event: Event): void {
    event.stopPropagation();
    this.deadLog.set({ stage, items: [], loading: true, error: null });
    this.api.listDead(stage.name).subscribe({
      next: (res) => {
        this.deadLog.update((cur) =>
          cur?.stage.name === stage.name ? { ...cur, items: res.items, loading: false } : cur,
        );
      },
      error: (err) => {
        this.deadLog.update((cur) =>
          cur?.stage.name === stage.name
            ? { ...cur, loading: false, error: errorMessage(err) }
            : cur,
        );
      },
    });
  }

  closeLog(): void {
    this.deadLog.set(null);
  }

  /** Open the damaged-files drawer and load the list. Collection-level, so it
   * takes no stage argument. */
  openDamaged(): void {
    this.damagedLog.set({ items: [], loading: true, error: null, clearing: false });
    this.api.listDamaged().subscribe({
      next: (res) => {
        this.damagedLog.update((cur) =>
          cur ? { ...cur, items: res.items, loading: false } : cur,
        );
      },
      error: (err) => {
        this.damagedLog.update((cur) =>
          cur ? { ...cur, loading: false, error: errorMessage(err) } : cur,
        );
      },
    });
  }

  closeDamaged(): void {
    this.damagedLog.set(null);
  }

  /** Clear the damaged tag for one asset (id given) or all (id omitted) and
   * re-queue. Refreshes the drawer from the server on success so the cleared
   * rows drop out. */
  clearDamaged(id?: string): void {
    const cur = this.damagedLog();
    if (!cur || cur.clearing) return;
    this.damagedLog.set({ ...cur, clearing: true });
    this.api.clearDamaged(id).subscribe({
      next: () => {
        // Re-list so the drawer reflects the server (and the pill count
        // re-syncs on the next status frame). `openDamaged` resets `clearing`.
        this.openDamaged();
      },
      error: (err) => {
        this.damagedLog.update((c) =>
          c ? { ...c, clearing: false, error: errorMessage(err) } : c,
        );
      },
    });
  }

  @HostListener('document:keydown.escape')
  onEscape(): void {
    if (this.deadLog() !== null) this.closeLog();
    if (this.damagedLog() !== null) this.closeDamaged();
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
    } else if (meta.enrichment === 'meili') {
      const url = form.meilisearch_url.trim();
      if (url.length === 0) {
        finishErr(new Error('Enter a URL to test.'));
        return;
      }
      // Probe with the typed key if present; otherwise the server falls back
      // to the saved key / env var.
      this.enrichmentApi.testMeilisearch(url, form.meilisearch_api_key.trim() || null).subscribe({
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
    } else if (kind === 'meili') {
      body.meilisearch_url = form.meilisearch_url.trim() || null;
      // Write-only key: only send it when the operator typed something.
      // Blank → omit → server leaves the saved key unchanged (it's masked
      // in the UI, so a blank field must not wipe it).
      const key = form.meilisearch_api_key.trim();
      if (key.length > 0) body.meilisearch_api_key = key;
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
  pendingTitle = pendingTitle;
  formatBytes = formatBytes;
  formatDate = formatDate;

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
