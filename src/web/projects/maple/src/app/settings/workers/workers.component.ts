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
  type WorkerConfig,
  type WorkersStatusResponse,
} from '@maple-common';
import { SettingsShellComponent } from '../settings-shell.component';
import { SettingsIconComponent, type SettingsIconName } from '../settings-icon.component';

const POLL_MS = 2_000;
const ERROR_POLL_MS = 5_000;

type StageGroup = 'Ingest' | 'Enrich' | 'Index';
type EnrichmentKind = 'describe' | 'geocode' | 'face';

interface StageMeta {
  readonly id: string;
  readonly group: StageGroup;
  readonly icon: SettingsIconName;
  readonly description: string;
  readonly enrichment: EnrichmentKind | null;
}

// Visual grouping + descriptions for each stage. Stages the server
// reports but we don't recognise still render at the bottom of "Ingest"
// with a default description, so an added worker shows up without code
// changes.
const STAGE_META: Record<string, StageMeta> = {
  hash:     { id: 'hash',     group: 'Ingest', icon: 'hash',   enrichment: null,
              description: 'Computes content hash for each new asset; deduplicates on ingest.' },
  exif:     { id: 'exif',     group: 'Ingest', icon: 'exif',   enrichment: null,
              description: 'Extracts EXIF/XMP metadata: camera, lens, exposure, GPS, dates.' },
  thumb:    { id: 'thumb',    group: 'Ingest', icon: 'thumb',  enrichment: null,
              description: 'Generates 256-px grid thumbnails and stores them in the thumb cache.' },
  preview:  { id: 'preview',  group: 'Ingest', icon: 'image',  enrichment: null,
              description: 'Builds 1280-px preview cache used by the editor and enrichment LLM.' },
  describe: { id: 'describe', group: 'Enrich', icon: 'sparkle', enrichment: 'describe',
              description: 'Local vision-LLM via Ollama. Runs a multimodal model against the preview cache and produces a structured caption plus OCR text.' },
  geocode:  { id: 'geocode',  group: 'Enrich', icon: 'globe',  enrichment: 'geocode',
              description: 'Reverse-geocodes EXIF GPS coordinates against a self-hosted Nominatim instance.' },
  face:     { id: 'face',     group: 'Enrich', icon: 'face',   enrichment: 'face',
              description: 'Detects faces in cached thumbnails using RetinaFace + MobileFaceNet (ONNX).' },
  meili:    { id: 'meili',    group: 'Index',  icon: 'search', enrichment: null,
              description: 'Pushes enriched assets to Meilisearch so they show up in the library search.' },
};

/** Per-stage form state for the runtime knobs in the expanded panel.
 * Lazily populated when a row is first expanded so unsaved values
 * survive a poll without flickering. */
interface RuntimeForm {
  concurrency: string;
  pollIntervalMs: string;
  batchSize: string;
  maxAttempts: string;
}

/** Per-stage form state for the enrichment domain config. */
interface EnrichmentForm {
  // Describe
  describe_provider_url: string;
  describe_model: string;
  describe_preview_size: string;
  // Geocode
  nominatim_url: string;
  nominatim_rate_limit_per_sec: string;
  // Face
  face_model_dir: string;
  face_retinaface_url: string;
  face_retinaface_sha256: string;
  face_mobilefacenet_url: string;
  face_mobilefacenet_sha256: string;
}

type SaveState = 'idle' | 'saving' | 'success' | 'error';

@Component({
  selector: 'maple-workers-settings',
  standalone: true,
  imports: [DecimalPipe, FormsModule, SettingsShellComponent, SettingsIconComponent],
  templateUrl: './workers.component.html',
  styleUrl: './workers.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class WorkersComponent implements OnInit, OnDestroy {
  private readonly api = inject(WorkersApiService);
  private readonly enrichmentApi = inject(BunApiBackendService);

  protected readonly status = signal<WorkersStatusResponse | null>(null);
  protected readonly error = signal<string | null>(null);
  protected readonly expanded = signal<Record<string, boolean>>({});
  protected readonly enrichmentConfig = signal<EnrichmentConfigResponse | null>(null);

  // Per-stage form state — keyed by stage id. Empty until the row expands.
  protected readonly runtimeForms = signal<Record<string, RuntimeForm>>({});
  protected readonly enrichmentForms = signal<Record<string, EnrichmentForm>>({});

  protected readonly saveStates = signal<Record<string, SaveState>>({});
  protected readonly saveErrors = signal<Record<string, string | null>>({});

  /** "Test connection" state for the URL field in describe/geocode rows.
   * Keyed by stage id so each row tracks its own probe independently. */
  protected readonly testStates = signal<
    Record<string, { kind: 'idle' } | { kind: 'testing' } | { kind: 'ok' } | { kind: 'error'; message: string }>
  >({});

  protected readonly stages = computed<StageStatus[]>(() => this.status()?.stages ?? []);

  /** Stages grouped + sorted in pipeline order. Stages we don't know
   * about land in Ingest at the end. */
  protected readonly groupedStages = computed<readonly { group: StageGroup; rows: StageStatus[] }[]>(() => {
    const order: StageGroup[] = ['Ingest', 'Enrich', 'Index'];
    const stages = this.stages();
    const groups: Record<StageGroup, StageStatus[]> = { Ingest: [], Enrich: [], Index: [] };
    for (const s of stages) {
      const g = STAGE_META[s.name]?.group ?? 'Ingest';
      groups[g].push(s);
    }
    return order.map((g) => ({ group: g, rows: groups[g] }));
  });

  protected readonly summary = computed(() => {
    const stages = this.stages();
    return {
      running: stages.filter((s) => s.status === 'running').length,
      paused: stages.filter((s) => s.status === 'paused').length,
      dead: stages.reduce((acc, s) => acc + s.dead, 0),
      pending: stages.reduce((acc, s) => acc + s.pending, 0),
    };
  });

  private pollSub: Subscription | null = null;
  private pollTimer: ReturnType<typeof setTimeout> | null = null;
  private destroyed = false;

  ngOnInit(): void {
    this.fetchStatus();
    this.enrichmentApi.getEnrichmentConfig().subscribe({
      next: (cfg) => this.enrichmentConfig.set(cfg),
      // Non-fatal; the runtime knobs still work without enrichment config.
      error: () => { /* ignore */ },
    });
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
        this.error.set(this.errorMessage(err) ?? 'Failed to load worker status.');
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
    const obs = stage.status === 'paused' ? this.api.resume(stage.name) : this.api.pause(stage.name);
    obs.subscribe({
      next: () => { /* next poll will sync */ },
      error: () => this.setLocalStatus(stage.name, stage.status),
    });
  }

  retryDead(stage: StageStatus, event: Event): void {
    event.stopPropagation();
    this.api.retryDead(stage.name).subscribe({ next: () => { /* poll syncs */ } });
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
        ...cur, [stage.name]: { kind: 'error', message: this.errorMessage(err) },
      }));

    if (meta.enrichment === 'geocode') {
      const url = form.nominatim_url.trim();
      if (url.length === 0) {
        finishErr(new Error('Enter a URL to test.'));
        return;
      }
      this.enrichmentApi.testNominatim(url).subscribe({
        next: (res) => res.ok ? finishOk() : finishErr(new Error(res.error ?? 'Health check failed')),
        error: finishErr,
      });
    } else if (meta.enrichment === 'describe') {
      this.enrichmentApi
        .testDescribeProvider({
          provider: 'ollama',
          url: form.describe_provider_url.trim() || null,
          model: form.describe_model.trim() || null,
          api_key: null,
        })
        .subscribe({
          next: (res) => res.ok ? finishOk() : finishErr(new Error(res.error ?? 'Health check failed')),
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
      const cfg = stage.config ?? { concurrency: 1, pollIntervalMs: 1000, batchSize: 10, maxAttempts: 5 };
      this.runtimeForms.update((cur) => ({
        ...cur,
        [stage.name]: {
          concurrency: String(cfg.concurrency),
          pollIntervalMs: String(cfg.pollIntervalMs),
          batchSize: String(cfg.batchSize),
          maxAttempts: String(cfg.maxAttempts),
        },
      }));
    }
    const meta = STAGE_META[stage.name];
    if (meta?.enrichment && !this.enrichmentForms()[stage.name]) {
      const ec = this.enrichmentConfig();
      this.enrichmentForms.update((cur) => ({
        ...cur,
        [stage.name]: {
          describe_provider_url: ec?.describe_provider_url ?? '',
          describe_model: ec?.describe_model ?? 'qwen2.5vl:7b',
          describe_preview_size: '1280',
          nominatim_url: ec?.nominatim_url ?? '',
          nominatim_rate_limit_per_sec: String(ec?.nominatim_rate_limit_per_sec ?? 10),
          face_model_dir: ec?.face_model_dir ?? '',
          face_retinaface_url: ec?.face_retinaface_url ?? '',
          face_retinaface_sha256: ec?.face_retinaface_sha256 ?? '',
          face_mobilefacenet_url: ec?.face_mobilefacenet_url ?? '',
          face_mobilefacenet_sha256: ec?.face_mobilefacenet_sha256 ?? '',
        },
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
    const patch: Partial<WorkerConfig> = {
      concurrency: this.parseInt(form.concurrency, 1, 32, 2),
      pollIntervalMs: this.parseInt(form.pollIntervalMs, 100, 60_000, 1000),
      batchSize: this.parseInt(form.batchSize, 1, 100, 5),
      maxAttempts: this.parseInt(form.maxAttempts, 1, 20, 5),
    };
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
      this.saveErrors.update((cur) => ({ ...cur, [stage.name]: this.errorMessage(err) }));
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
    if (!form) { onOk(); return; }
    const body: Parameters<BunApiBackendService['saveEnrichmentConfig']>[0] = {
      nominatim_url: null,
      geocode_worker_enabled: this.enrichmentConfig()?.geocode_worker_enabled ?? true,
    };
    if (kind === 'describe') {
      body.describe_provider_url = form.describe_provider_url.trim() || null;
      body.describe_model = form.describe_model.trim() || null;
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
      const cur1 = cur[stage.name] ?? this.blankRuntime(stage);
      return { ...cur, [stage.name]: { ...cur1, [field]: value } };
    });
  }
  enrichmentValue(stage: StageStatus, field: keyof EnrichmentForm): string {
    return this.enrichmentForms()[stage.name]?.[field] ?? '';
  }
  setEnrichment(stage: StageStatus, field: keyof EnrichmentForm, value: string): void {
    this.enrichmentForms.update((cur) => {
      const cur1 = cur[stage.name] ?? this.blankEnrichment();
      return { ...cur, [stage.name]: { ...cur1, [field]: value } };
    });
  }

  private blankRuntime(stage: StageStatus): RuntimeForm {
    const cfg = stage.config;
    return {
      concurrency: String(cfg?.concurrency ?? 2),
      pollIntervalMs: String(cfg?.pollIntervalMs ?? 1000),
      batchSize: String(cfg?.batchSize ?? 5),
      maxAttempts: String(cfg?.maxAttempts ?? 5),
    };
  }
  private blankEnrichment(): EnrichmentForm {
    const ec = this.enrichmentConfig();
    return {
      describe_provider_url: ec?.describe_provider_url ?? '',
      describe_model: ec?.describe_model ?? 'qwen2.5vl:7b',
      describe_preview_size: '1280',
      nominatim_url: ec?.nominatim_url ?? '',
      nominatim_rate_limit_per_sec: String(ec?.nominatim_rate_limit_per_sec ?? 10),
      face_model_dir: ec?.face_model_dir ?? '',
      face_retinaface_url: ec?.face_retinaface_url ?? '',
      face_retinaface_sha256: ec?.face_retinaface_sha256 ?? '',
      face_mobilefacenet_url: ec?.face_mobilefacenet_url ?? '',
      face_mobilefacenet_sha256: ec?.face_mobilefacenet_sha256 ?? '',
    };
  }

  // ── Display helpers ─────────────────────────────────────────────────────

  meta(stage: StageStatus): StageMeta {
    return STAGE_META[stage.name] ?? {
      id: stage.name, group: 'Ingest', icon: 'pipe', description: '', enrichment: null,
    };
  }

  statusLabel(s: StageStatus): string {
    switch (s.status) {
      case 'running':    return 'Running';
      case 'paused':     return 'Paused';
      case 'error':      return 'Error';
      case 'starting':   return 'Starting';
      case 'restarting': return 'Restarting';
      case 'stopped':    return 'Stopped';
    }
  }

  statusDotColor(s: StageStatus): string {
    switch (s.status) {
      case 'running':    return '#4ade80';
      case 'paused':
      case 'starting':
      case 'restarting':
      case 'stopped':    return '#a8a29e';
      case 'error':      return '#f87171';
    }
  }

  throughputLabel(s: StageStatus): string {
    return s.throughput > 0 ? `${s.throughput}` : '—';
  }

  saveState(s: StageStatus): SaveState {
    return this.saveStates()[s.name] ?? 'idle';
  }
  saveError(s: StageStatus): string | null {
    return this.saveErrors()[s.name] ?? null;
  }

  private setLocalStatus(name: string, status: StageStatus['status']): void {
    this.status.update((cur) => {
      if (!cur) return cur;
      return { stages: cur.stages.map((s) => s.name === name ? { ...s, status } : s) };
    });
  }

  private parseInt(value: string, min: number, max: number, fallback: number): number {
    const n = Number.parseInt(value, 10);
    if (!Number.isFinite(n)) return fallback;
    return Math.min(max, Math.max(min, n));
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
}
