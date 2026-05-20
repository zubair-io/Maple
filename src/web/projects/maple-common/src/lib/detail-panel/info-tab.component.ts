// Info tab — file metadata, camera, rating/flags, location, dates, IPTC, history.
// Shared between Browse and Editor apps via maple-common.
// Ported from _design-reference/lib/detail.jsx InfoTab / KV / EditableRow.
//
// Self-Hosted extension: when the focused asset has a known API id (Self
// Hosted backend), this component fetches the per-asset enrichment payload
// (place, description, vision, faces) from the Bun API and surfaces four
// editable sections at the bottom of the pane. Each section supports a
// manual override (PUT) and a re-X button (POST requeue). After a requeue,
// the component polls the asset every 2s for 30s to pick up the new value.

import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  inject,
  signal,
  Injector,
  OnDestroy,
  runInInjectionContext,
} from '@angular/core';
import { LibraryStateService } from '../state/library-state.service';
import { MapleIconComponent } from '../icons/maple-icon.component';
import { MapleCollapsibleComponent } from '../collapsible/maple-collapsible.component';
import { Asset, ColorLabel, Flag } from '../models/asset';
import { LIBRARY_BACKEND } from '../api/library-backend.token';
import {
  BunApiBackendService,
  ApiAssetDetail,
  ApiEnrichmentStage,
  ApiEnrichmentStageState,
} from '../api/bun-api-backend.service';
import { Subscription } from 'rxjs';
import { OsmMapThumbComponent } from './osm-map-thumb.component';
import {
  EnrichmentStatusBadgeComponent,
  EnrichmentStageStatus,
} from './enrichment-status-badge.component';

const COLOR_LABELS: { name: ColorLabel; hex: string }[] = [
  { name: 'red', hex: '#e74c3c' },
  { name: 'orange', hex: '#e9873f' },
  { name: 'yellow', hex: '#e9b93f' },
  { name: 'green', hex: '#4ade80' },
  { name: 'blue', hex: '#6aa0d4' },
];

/** How long the post-requeue refresh poll runs before giving up. */
const REFRESH_TIMEOUT_MS = 30_000;
/** Poll interval inside the refresh window. */
const REFRESH_POLL_MS = 2_000;

@Component({
  selector: 'maple-info-tab',
  standalone: true,
  imports: [
    MapleIconComponent,
    MapleCollapsibleComponent,
    OsmMapThumbComponent,
    EnrichmentStatusBadgeComponent,
  ],
  styleUrl: './info-tab.component.scss',
  templateUrl: './info-tab.component.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class InfoTabComponent implements OnDestroy {
  state = inject(LibraryStateService);
  private readonly api = inject(BunApiBackendService);
  private readonly backend = inject(LIBRARY_BACKEND);
  private readonly injector = inject(Injector);

  readonly STAR_INDICES = [1, 2, 3, 4, 5];
  readonly COLOR_LABELS = COLOR_LABELS;
  readonly HISTORY = [
    { label: 'Original import', time: 'Import' },
    { label: 'Basic tone', time: '3d ago' },
    { label: 'Warm grade', time: '2h ago' },
  ];

  // ── Self-Hosted enrichment state ──────────────────────────────────────
  readonly selfHosted = this.backend === 'self-hosted';

  /** Deep link for "Worker paused" badges and stale-after-requeue hints.
   * The workers admin page already exists at this route. */
  readonly WORKERS_SETTINGS_URL = '/settings/workers';

  /** The last-fetched detail for the currently-focused asset. Cleared
   * whenever the focused asset changes. */
  readonly detail = signal<ApiAssetDetail | null>(null);

  /** Per-stage paused flag from GET /api/workers/status. Empty record
   * means "not yet fetched" — render as if not paused (so we don't show
   * the misleading "Worker paused" badge before we know). */
  readonly workerPaused = signal<Partial<Record<ApiEnrichmentStage, boolean>>>(
    {},
  );

  /** Per-stage last error string from the most recent Re-* or override
   * click. Cleared on the next successful click for the same stage. */
  readonly lastClickError = signal<Partial<Record<ApiEnrichmentStage, string>>>(
    {},
  );

  /** Per-stage flag set when the 30 s polling window expires without
   * `done_at` flipping. Tells the user the row is stuck rather than
   * actively in flight. Cleared on focus change and on the next click. */
  readonly staleAfterRequeue = signal<Partial<Record<ApiEnrichmentStage, true>>>(
    {},
  );

  // Per-section edit state. Local UI signals; not persisted.
  readonly placeEditing = signal(false);
  readonly placeDraft = signal('');
  readonly descriptionEditing = signal(false);
  readonly descriptionDraft = signal('');

  /** API id of the asset currently fetched. Recomputed from the focused
   * asset's local id via `state.apiIdFor`. */
  private readonly apiAssetId = computed(() => {
    const asset = this.state.focusedAsset();
    if (!asset) return null;
    return this.state.apiIdFor(asset.id) ?? null;
  });

  /** Active subscription for the in-flight detail fetch. We hold the ref
   * so a focus change cancels the prior fetch. */
  private detailSub: Subscription | null = null;
  /** Polling timer + deadline for the post-requeue refresh window. */
  private refreshTimer: ReturnType<typeof setInterval> | null = null;
  private refreshDeadline = 0;
  /** Snapshot taken at requeue time; the poll stops when something
   * changes (`done_at` flips, version bumps, dead_letter clears, etc). */
  private refreshBaseline: ApiAssetDetail | null = null;
  /** Stage whose Re-* click started the current refresh loop, so we can
   * surface a row-specific "Still pending" hint on deadline expiry. */
  private refreshStage: ApiEnrichmentStage | null = null;

  constructor() {
    // Refetch detail on focus change. Self-Hosted only — Hosted has no
    // server-side enrichment payload.
    if (this.selfHosted) {
      this.fetchWorkerStatus();
      effect(() => {
        const apiId = this.apiAssetId();
        // Reset edit state and per-stage UI signals on focus change so
        // stale state from the previous asset doesn't leak through.
        this.cancelAllEdits();
        this.lastClickError.set({});
        this.staleAfterRequeue.set({});
        this.detail.set(null);
        this.stopRefreshLoop();
        if (apiId) this.fetchDetail(apiId);
      });
    }
  }

  /** Pull `config.paused` per stage from /api/workers/status. Called once
   * on init and refreshed on every Re-* click so a worker enabled in
   * another tab doesn't leave us showing a stale "Worker paused" badge. */
  private fetchWorkerStatus(): void {
    this.api.getWorkerStatus().subscribe({
      next: (status) => {
        const next: Partial<Record<ApiEnrichmentStage, boolean>> = {};
        for (const s of status.stages) {
          if (s.name === 'geocode' || s.name === 'describe' || s.name === 'face') {
            // Trust `config.paused` first; fall back to the `status` string
            // which the API also exposes as "paused" when the config flag
            // is set on a running child.
            next[s.name] = s.config?.paused === true || s.status === 'paused';
          }
        }
        this.workerPaused.set(next);
      },
      error: () => {
        // Worker status endpoint unreachable — leave the cache empty.
        // The UI will show "Pending" (not "Worker paused"), which is the
        // best we can do without that signal.
      },
    });
  }

  ngOnDestroy(): void {
    this.detailSub?.unsubscribe();
    this.stopRefreshLoop();
  }

  // ── Detail fetch / refresh loop ───────────────────────────────────────

  private fetchDetail(apiId: string): void {
    this.detailSub?.unsubscribe();
    this.detailSub = this.api.getAssetDetails(apiId).subscribe({
      next: (d) => this.detail.set(d),
      error: () => {
        // Swallow — the section just stays empty. The `selfHosted &&
        // detail()` template guard keeps the UI clean.
      },
    });
  }

  /** Used by the requeue and refresh-poll paths so an inline error message
   * shows up under the row without leaking the raw HTTP error to the UI. */
  private setStageError(stage: ApiEnrichmentStage, message: string): void {
    this.lastClickError.update((m) => ({ ...m, [stage]: message }));
  }

  /** Clear the per-stage error + stale hint — called right before we
   * kick off a new request so the old message doesn't sit there. */
  private clearStageFeedback(stage: ApiEnrichmentStage): void {
    this.lastClickError.update((m) => {
      const next = { ...m };
      delete next[stage];
      return next;
    });
    this.staleAfterRequeue.update((m) => {
      const next = { ...m };
      delete next[stage];
      return next;
    });
  }

  /** After a requeue, poll the asset every 2 s for up to 30 s, stopping
   * as soon as the worker has clearly run (any per-stage state field
   * meaningfully different from the snapshot at requeue time). The
   * `stage` argument is the one the user clicked — if the deadline
   * expires without progress, we flag that stage's row as stale so the
   * user sees something other than a frozen "Pending" badge. */
  private startRefreshLoop(stage: ApiEnrichmentStage): void {
    if (!this.selfHosted) return;
    const apiId = this.apiAssetId();
    if (!apiId) return;
    this.stopRefreshLoop();
    this.refreshBaseline = this.detail();
    this.refreshStage = stage;
    this.refreshDeadline = Date.now() + REFRESH_TIMEOUT_MS;
    this.refreshTimer = setInterval(() => {
      if (Date.now() > this.refreshDeadline) {
        const expiredStage = this.refreshStage;
        if (expiredStage) {
          this.staleAfterRequeue.update((m) => ({ ...m, [expiredStage]: true }));
        }
        this.stopRefreshLoop();
        return;
      }
      const id = this.apiAssetId();
      if (!id) {
        this.stopRefreshLoop();
        return;
      }
      this.api.getAssetDetails(id).subscribe({
        next: (d) => {
          this.detail.set(d);
          if (this.detailChanged(this.refreshBaseline, d)) {
            this.stopRefreshLoop();
          }
        },
        error: () => {
          // A transient poll failure shouldn't kill the loop — the next
          // tick will try again. If the deadline expires we'll surface
          // it via `staleAfterRequeue` then.
        },
      });
    }, REFRESH_POLL_MS);
  }

  private stopRefreshLoop(): void {
    if (this.refreshTimer !== null) {
      clearInterval(this.refreshTimer);
      this.refreshTimer = null;
    }
    this.refreshBaseline = null;
    this.refreshStage = null;
    this.refreshDeadline = 0;
  }

  /** True when something in the enrichment subdoc moved between the two
   * snapshots — a worker run flipped `done_at`, bumped `version`, cleared
   * an error, etc. */
  private detailChanged(
    a: ApiAssetDetail | null,
    b: ApiAssetDetail | null,
  ): boolean {
    if (!a || !b) return true;
    const stages: ApiEnrichmentStage[] = [
      'geocode',
      'face',
      'describe',
    ];
    for (const s of stages) {
      const sa = a.enrichment[s];
      const sb = b.enrichment[s];
      if (sa.done_at !== sb.done_at) return true;
      if (sa.version !== sb.version) return true;
      if (sa.dead_letter_at !== sb.dead_letter_at) return true;
    }
    return false;
  }

  // ── Helpers ───────────────────────────────────────────────────────────

  showPlaceSection(d: ApiAssetDetail): boolean {
    // Hide once geocoded as no-place (worker ran, found nothing). The
    // worker writes `place: null` AND sets `done_at` non-null in that
    // case; pending rows have `done_at: null`.
    if (d.place === null && d.enrichment.geocode.done_at !== null) {
      return false;
    }
    return true;
  }

  formatRollups(rollups: { locality: string | null; region: string | null }): string {
    const parts = [rollups.locality, rollups.region].filter(
      (v): v is string => !!v,
    );
    if (parts.length === 0) return '(no rollup)';
    return parts.join(', ');
  }

  taggedFaces(d: ApiAssetDetail): { person_id: string }[] {
    return d.faces
      .filter((f) => f.person_id !== null)
      .map((f) => ({ person_id: f.person_id! }));
  }

  untaggedFaceCount(d: ApiAssetDetail): number {
    return d.faces.filter((f) => f.person_id === null).length;
  }

  // ── Edit-mode toggles ─────────────────────────────────────────────────

  startPlaceEdit(d: ApiAssetDetail): void {
    this.placeDraft.set(d.place?.display_name ?? '');
    this.placeEditing.set(true);
  }
  cancelPlaceEdit(): void {
    this.placeEditing.set(false);
    this.placeDraft.set('');
  }
  savePlaceEdit(d: ApiAssetDetail): void {
    const text = this.placeDraft().trim();
    // The override route accepts a full Place document (the worker's
    // output shape). For a manual single-line correction we synthesise
    // a minimal Place keyed off the existing one; if the row had no
    // place at all, we send a stub with display_name + everything else
    // empty so it at least surfaces in the UI.
    const next = text
      ? {
          source: 'manual',
          geocoder_version: 0,
          geocoded_at: new Date().toISOString(),
          lat: d.place?.lat ?? 0,
          lon: d.place?.lon ?? 0,
          display_name: text,
          address: d.place?.address ?? {},
          pois: d.place?.pois ?? [],
          rollups: d.place?.rollups ?? {
            locality: null,
            region: null,
            country_code: null,
          },
          search_blob: text.toLowerCase(),
        }
      : null;
    this.clearStageFeedback('geocode');
    this.api.setAssetPlaceOverride(d.id, next).subscribe({
      next: () => {
        this.placeEditing.set(false);
        this.refetchAfterMutation();
      },
      error: () => {
        this.setStageError('geocode', 'Failed to save — try again.');
      },
    });
  }

  startDescriptionEdit(d: ApiAssetDetail): void {
    this.descriptionDraft.set(d.description ?? '');
    this.descriptionEditing.set(true);
  }
  cancelDescriptionEdit(): void {
    this.descriptionEditing.set(false);
    this.descriptionDraft.set('');
  }
  saveDescriptionEdit(d: ApiAssetDetail): void {
    const text = this.descriptionDraft();
    this.clearStageFeedback('describe');
    this.api
      .setAssetDescriptionOverride(d.id, text.length > 0 ? text : null)
      .subscribe({
        next: () => {
          this.descriptionEditing.set(false);
          this.refetchAfterMutation();
        },
        error: () => {
          this.setStageError('describe', 'Failed to save — try again.');
        },
      });
  }

  private cancelAllEdits(): void {
    this.cancelPlaceEdit();
    this.cancelDescriptionEdit();
  }

  /** Refetch the detail once after a manual override (no polling — the
   * field went directly to Mongo, so the next read is enough). */
  private refetchAfterMutation(): void {
    const apiId = this.apiAssetId();
    if (!apiId) return;
    runInInjectionContext(this.injector, () => this.fetchDetail(apiId));
  }

  // ── Requeue ───────────────────────────────────────────────────────────

  requeue(d: ApiAssetDetail, stage: ApiEnrichmentStage): void {
    this.clearStageFeedback(stage);
    // Refresh worker pause flags in the background — catches the case
    // where the user enabled (or paused) a worker in another tab.
    this.fetchWorkerStatus();
    this.api.requeueEnrichmentStage(d.id, stage).subscribe({
      next: () => {
        // Clear the per-stage `done_at` locally so the Pending badge
        // appears immediately, then start polling for the worker's
        // result.
        const current = this.detail();
        if (current) {
          this.detail.set({
            ...current,
            enrichment: {
              ...current.enrichment,
              [stage]: {
                ...current.enrichment[stage],
                done_at: null,
                dead_letter_at: null,
                last_error: null,
              },
            },
          });
        }
        this.startRefreshLoop(stage);
      },
      error: () => {
        this.setStageError(stage, 'Failed to requeue — try again.');
      },
    });
  }

  // ── Existing helpers ──────────────────────────────────────────────────

  ext(filename: string): string {
    return filename.split('.').pop() ?? '';
  }

  xmpName(filename: string): string {
    return filename.replace(/\.[^.]+$/, '.xmp');
  }

  formatSize(bytes: number | undefined): string {
    if (bytes == null) return '—';
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
    return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
  }

  formatDate(iso: string | undefined): string {
    if (!iso) return '—';
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return iso;
    const yyyy = d.getFullYear();
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    const dd = String(d.getDate()).padStart(2, '0');
    const hh = String(d.getHours()).padStart(2, '0');
    const mi = String(d.getMinutes()).padStart(2, '0');
    return `${yyyy}-${mm}-${dd} ${hh}:${mi}`;
  }

  toggleFlag(asset: Asset, flag: Flag): void {
    const next: Flag = asset.flag === flag ? 'unflagged' : flag;
    this.state.setFlag(asset.id, next);
  }

  toggleStar(asset: Asset, star: number): void {
    const next = asset.rating === star ? 0 : star;
    this.state.setRating(asset.id, next);
  }

  toggleColor(asset: Asset, label: ColorLabel): void {
    const next: ColorLabel = asset.colorLabel === label ? null : label;
    this.state.setColorLabel(asset.id, next);
  }

  // ── Enrichment status derivation ──────────────────────────────────────

  /** Decide what badge to show for a stage row. The DTO carries enough
   * fields to pin down every state — we layer the worker-pause cache on
   * top so a paused-on-first-boot stage reads as "Worker paused" instead
   * of an indefinite "Pending". Priority order matches the table in the
   * plan: failed > skipped > complete > paused > running > pending. */
  stageStatus(
    stage: ApiEnrichmentStage,
    s: ApiEnrichmentStageState,
  ): EnrichmentStageStatus {
    if (s.dead_letter_at) {
      return { kind: 'failed', label: 'Failed', tooltip: s.last_error ?? undefined };
    }
    // A "skip: …" last_error means the worker decided not to process the
    // asset — done_at is also set in that case (the supervisor stamps
    // both fields in the skip path).
    if (s.last_error?.startsWith('skip: ')) {
      const reason = s.last_error.slice('skip: '.length);
      return { kind: 'skipped', label: this.skipReasonLabel(reason), tooltip: s.last_error };
    }
    if (s.done_at !== null) {
      // Complete — no badge needed.
      return { kind: 'complete', label: '' };
    }
    if (this.workerPaused()[stage]) {
      return { kind: 'paused', label: 'Worker paused' };
    }
    // Treat a live lease as "Running…"; otherwise the row is queued for
    // the next supervisor tick.
    if (s.locked_by && s.lease_expires_at) {
      const expires = Date.parse(s.lease_expires_at);
      if (Number.isFinite(expires) && expires > Date.now()) {
        return { kind: 'running', label: 'Running…' };
      }
    }
    return { kind: 'pending', label: 'Pending' };
  }

  /** Human label for a `skip: …` reason. Falls back to a generic
   * "Skipped" with the raw reason in the tooltip so we don't lose info
   * for skip cases the workers may add later. */
  private skipReasonLabel(reason: string): string {
    if (reason === 'no-gps') return 'No GPS';
    if (reason === 'image-missing') return 'No thumbnail';
    if (reason.startsWith('thumb-missing')) return 'No thumbnail';
    if (reason.startsWith('thumb-undecodable')) return 'Thumbnail unreadable';
    return 'Skipped';
  }

}
