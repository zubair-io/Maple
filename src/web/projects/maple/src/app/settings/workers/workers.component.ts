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
//    - WorkerEventsService.workersStatus$ streams live status / counters /
//      per-stage config over the /api/events WS bridge (#674). A one-shot
//      WorkersApiService.getStatus() paints the page before the WS handshake
//      and serves as a non-WS fallback.
//    - BunApiBackendService.getEnrichmentConfig() supplies the domain
//      config for describe/geocode/face stages plus the live face-model
//      loader banner.
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
import { RouterLink } from '@angular/router';
import { DecimalPipe } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { type Subscription } from 'rxjs';
import {
  BunApiBackendService,
  type DeadDoc,
  type EnrichmentConfigResponse,
  type PerformanceConfig,
  WorkerEventsService,
  WorkersApiService,
  type StageStatus,
  type WorkersStatusResponse,
} from '@maple-common';
import { DamagedPanelService } from './damaged-panel.service';
import { MigrationPanelService } from './migration-panel.service';
import { ImportsPanelService } from './imports-panel.service';
import { SettingsShellComponent } from '../settings-shell.component';
import { SettingsIconComponent } from '../settings-icon.component';
import { SettingsRowComponent } from '../settings-row.component';
import { MirrorSettingsComponent } from './mirror-settings.component';
import { DerivativeAuditSettingsComponent } from './derivative-audit-settings.component';
import { FacePurgePanelComponent } from './face-purge-panel.component';
import {
  FIXED_DESCRIBE_MODEL,
  groupStagesByPipeline,
  summarizeStages,
  stageMeta,
  statusLabel,
  statusDotColor,
  throughputLabel,
  pendingTitle,
  formatBytes,
  formatDate,
  parseClampedInt,
  runtimeFormToPatch,
  blankRuntime,
  blankEnrichment,
  errorMessage,
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
  imports: [
    DecimalPipe,
    FormsModule,
    RouterLink,
    SettingsShellComponent,
    SettingsIconComponent,
    SettingsRowComponent,
    MirrorSettingsComponent,
    DerivativeAuditSettingsComponent,
    FacePurgePanelComponent,
  ],
  templateUrl: './workers.component.html',
  styleUrl: './workers.component.scss',
  providers: [DamagedPanelService, MigrationPanelService, ImportsPanelService],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class WorkersComponent implements OnInit, OnDestroy {
  protected readonly fixedDescribeModel = FIXED_DESCRIBE_MODEL;
  protected readonly damaged = inject(DamagedPanelService);
  protected readonly migration = inject(MigrationPanelService);
  protected readonly imports = inject(ImportsPanelService);
  private readonly api = inject(WorkersApiService);
  private readonly events = inject(WorkerEventsService);
  private readonly enrichmentApi = inject(BunApiBackendService);

  protected readonly status = signal<WorkersStatusResponse | null>(null);
  protected readonly error = signal<string | null>(null);
  protected readonly expanded = signal<Record<string, boolean>>({});
  protected readonly enrichmentConfig = signal<EnrichmentConfigResponse | null>(null);
  protected readonly enrichmentConfigError = signal<string | null>(null);

  protected readonly perfConfig = signal<PerformanceConfig | null>(null);
  protected readonly ffiWorkersDraft = signal<string>('');
  protected readonly perfSaveState = signal<SaveState>('idle');
  protected readonly perfSaveError = signal<string | null>(null);

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
  protected readonly testStates = signal<
    Record<
      string,
      { kind: 'idle' } | { kind: 'testing' } | { kind: 'ok' } | { kind: 'error'; message: string }
    >
  >({});
  protected readonly reaperPruneWindow = signal<string>('');
  protected readonly reaperPruneLoaded = signal<boolean>(false);
  protected readonly reaperPruneSaveState = signal<SaveState>('idle');
  protected readonly reaperPruneError = signal<string | null>(null);

  protected readonly stages = computed<StageStatus[]>(() => this.status()?.stages ?? []);
  protected readonly groupedStages = computed<
    readonly { group: StageGroup; rows: StageStatus[] }[]
  >(() => groupStagesByPipeline(this.stages()));
  protected readonly summary = computed(() => summarizeStages(this.stages()));
  protected readonly damagedCount = computed(() => this.status()?.damaged ?? 0);

  private statusSub: Subscription | null = null;
  private fallbackSub: Subscription | null = null;
  private destroyed = false;
  private gotWsFrame = false;

  ngOnInit(): void {
    this.subscribeStatus();
    this.fetchStatusFallback();
    this.fetchEnrichmentConfig();
    this.fetchReaperPruneWindow();
    this.fetchPerformanceConfig();
    // Migration panel state + light progress poll lives in its own service
    // (keeps this component under the file-size budget).
    this.migration.startPolling();
    this.imports.startPolling();
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

  private fetchPerformanceConfig(): void {
    this.api.getPerformanceConfig().subscribe({
      next: (cfg) => {
        this.perfConfig.set(cfg);
        if (this.ffiWorkersDraft() === '') this.ffiWorkersDraft.set(String(cfg.ffi_workers));
      },
      error: () => {},
    });
  }

  protected setFfiWorkersDraft(value: string): void {
    this.ffiWorkersDraft.set(value);
  }

  protected savePerformance(): void {
    const cfg = this.perfConfig();
    if (!cfg) return;
    const n = parseClampedInt(this.ffiWorkersDraft(), cfg.min, cfg.max, cfg.ffi_workers);
    this.perfSaveState.set('saving');
    this.perfSaveError.set(null);
    this.api.patchPerformanceConfig(n).subscribe({
      next: (res) => {
        this.perfConfig.update((cur) =>
          cur ? { ...cur, ffi_workers: res.ffi_workers, source: res.source, pool: res.pool } : cur,
        );
        this.ffiWorkersDraft.set(String(res.ffi_workers));
        this.perfSaveState.set('success');
        setTimeout(() => {
          if (this.perfSaveState() === 'success') this.perfSaveState.set('idle');
        }, 1500);
      },
      error: (err: unknown) => {
        this.perfSaveState.set('error');
        this.perfSaveError.set(errorMessage(err));
      },
    });
  }

  private fetchEnrichmentConfig(): void {
    this.enrichmentConfigError.set(null);
    this.enrichmentApi.getEnrichmentConfig().subscribe({
      next: (cfg) => this.enrichmentConfig.set(cfg),
      error: (err: unknown) => this.enrichmentConfigError.set(errorMessage(err)),
    });
  }

  protected retryEnrichmentConfig(): void {
    this.fetchEnrichmentConfig();
  }

  ngOnDestroy(): void {
    this.destroyed = true;
    this.statusSub?.unsubscribe();
    this.statusSub = null;
    this.fallbackSub?.unsubscribe();
    this.fallbackSub = null;
    this.migration.stopPolling();
    this.imports.stopPolling();
  }

  private subscribeStatus(): void {
    if (this.destroyed) return;
    this.statusSub = this.events.workersStatus$.subscribe({
      next: ({ status, counted }) => {
        if (counted) this.gotWsFrame = true;
        this.status.set(status);
        this.error.set(null);
      },
      error: (err) => {
        this.error.set(errorMessage(err) ?? 'Failed to load worker status.');
      },
    });
  }

  private fetchStatusFallback(): void {
    if (this.destroyed) return;
    this.statusSub = this.api.getStatus().subscribe({
      next: (data) => {
        if (this.gotWsFrame || this.destroyed) return;
        this.status.set(data);
      },
      error: () => {},
    });
  }

  toggleExpanded(stage: StageStatus): void {
    const next = !(this.expanded()[stage.name] ?? false);
    this.expanded.update((cur) => ({ ...cur, [stage.name]: next }));
    if (next) this.ensureForm(stage);
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
      next: () => {},
      error: () => this.setLocalStatus(stage.name, stage.status),
    });
  }

  retryDead(stage: StageStatus, event: Event): void {
    event.stopPropagation();
    this.api.retryDead(stage.name).subscribe({ next: () => {} });
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

  @HostListener('document:keydown.escape')
  onEscape(): void {
    if (this.deadLog() !== null) this.closeLog();
    if (this.damaged.drawer() !== null) this.damaged.close();
  }

  testConnection(stage: StageStatus): void {
    const meta = stageMeta(stage.name);
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

  private ensureForm(stage: StageStatus): void {
    if (!this.runtimeForms()[stage.name]) {
      this.runtimeForms.update((cur) => ({ ...cur, [stage.name]: blankRuntime(stage) }));
    }
    const meta = stageMeta(stage.name);
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

    const meta = stageMeta(stage.name);
    const finishOk = () => {
      this.saveStates.update((cur) => ({ ...cur, [stage.name]: 'success' }));
      setTimeout(() => {
        if (this.saveStates()[stage.name] === 'success') {
          this.saveStates.update((cur) => ({ ...cur, [stage.name]: 'idle' }));
        }
      }, 1500);
    };
    const finishErr = (err: unknown) => {
      this.saveStates.update((cur) => ({ ...cur, [stage.name]: 'error' }));
      this.saveErrors.update((cur) => ({ ...cur, [stage.name]: errorMessage(err) }));
    };

    this.api.patchConfig(stage.name, patch).subscribe({
      next: () => {
        if (meta?.enrichment) this.saveEnrichment(stage, meta.enrichment, finishOk, finishErr);
        else finishOk();
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
    } else if (kind === 'transcribe') {
      body.transcribe_model_tier = form.transcribe_model_tier as
        | 'tiny.en'
        | 'base.en'
        | 'small.en'
        | 'medium.en'
        | 'large-v3';
    } else if (kind === 'geocode') {
      body.nominatim_url = form.nominatim_url.trim() || null;
      const rate = Number(form.nominatim_rate_limit_per_sec.trim());
      body.nominatim_rate_limit_per_sec = Number.isFinite(rate) && rate > 0 ? rate : null;
    } else if (kind === 'face-detect') {
      // The PUT is patch/merge, so send ONLY the slice this row owns — the
      // detector config + the shared model dir. Sending recognizer fields too
      // would clobber the face-embed row's saved values with this form's stale
      // (seeded-at-expand) copy.
      body.face_model_dir = form.face_model_dir.trim() || null;
      body.face_detector_url = form.face_detector_url.trim() || null;
      body.face_detector_sha256 = form.face_detector_sha256.trim() || null;
      // Empty/whitespace clears back to the default (null) — NOT 0. A blank
      // input must never persist 0, which would silently DISABLE the filter
      // (0 is a valid "off" value, so it can't double as "cleared"). Only a
      // non-blank, in-range [0,1) number is sent as an explicit value.
      const minSizeRaw = form.face_min_detection_size.trim();
      const minSize = Number(minSizeRaw);
      body.face_min_detection_size =
        minSizeRaw !== '' && Number.isFinite(minSize) && minSize >= 0 && minSize < 1
          ? minSize
          : null;
    } else if (kind === 'face-embed') {
      // Recognizer-only slice — see the face-detect note above. The model dir
      // is owned by the face-detect row, so it is deliberately not sent here.
      body.face_recognizer_url = form.face_recognizer_url.trim() || null;
      body.face_recognizer_sha256 = form.face_recognizer_sha256.trim() || null;
    } else if (kind === 'meili') {
      body.meilisearch_url = form.meilisearch_url.trim() || null;
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
    return this.saveStates()?.[s.name] ?? 'idle';
  }

  saveError(s: StageStatus): string | null {
    return this.saveErrors()?.[s.name] ?? null;
  }

  saveDisabled(s: StageStatus): boolean {
    if (this.saveState(s) === 'saving') return true;
    const meta = stageMeta(s.name);
    if (meta?.enrichment && !this.enrichmentConfig()) return true;
    return false;
  }

  saveDisabledReason(s: StageStatus): string | null {
    const meta = stageMeta(s.name);
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
