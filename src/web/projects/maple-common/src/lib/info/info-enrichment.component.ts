// InfoEnrichmentComponent — Self-Hosted enrichment orchestrator.
//
// Owns the GET /assets/:id detail fetch, the GET /workers/status pause
// cache, the requeue POSTs, the manual-override PUTs, and the 30 s
// post-requeue poll loop. Composes four dumb leaves:
//   • <app-info-place>       — reverse-geocoded place + override + requeue
//   • <app-info-description> — qwen3-vl caption + override + requeue
//   • <app-info-vision>      — structured visual classification (read-only)
//   • <app-info-faces>       — face count + person chips + requeue
//
// This is the post-#634 replacement for the old `<maple-info-tab>`
// enrichment surface — same behaviour, split into focused pieces, gated
// on `LIBRARY_BACKEND === 'self-hosted'` by the parent `<app-info-panel>`.
//
// Lifecycle invariants worth keeping:
//   • detail subscription is replaced (not stacked) on every focus change.
//   • workerPaused cache is refreshed once on init and again on every
//     requeue click — catches an admin enabling/pausing a worker in
//     another tab.
//   • the post-requeue poll loop is one-at-a-time: a new requeue cancels
//     the previous loop before starting a new one. ngOnDestroy tears
//     both the subscription and the interval down.

import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  inject,
  Injector,
  OnDestroy,
  runInInjectionContext,
  signal,
} from '@angular/core';
import { Subscription } from 'rxjs';
import { LibraryStateService } from '../state/library-state.service';
import {
  BunApiBackendService,
  ApiAssetDetail,
  ApiEnrichmentStage,
  ApiPlace,
} from '../api/bun-api-backend.service';
import { InfoPlaceComponent } from './info-place.component';
import { InfoDescriptionComponent } from './info-description.component';
import { InfoVisionComponent } from './info-vision.component';
import { InfoTranscriptComponent } from './info-transcript.component';
import { InfoFacesComponent } from './info-faces.component';
import {
  REFRESH_POLL_MS,
  REFRESH_TIMEOUT_MS,
  detailChanged,
  showPlaceSection,
  stageStatus,
} from './enrichment.vm';

@Component({
  selector: 'app-info-enrichment',
  standalone: true,
  imports: [
    InfoPlaceComponent,
    InfoDescriptionComponent,
    InfoVisionComponent,
    InfoTranscriptComponent,
    InfoFacesComponent,
  ],
  templateUrl: './info-enrichment.component.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    class: 'block',
    'data-testid': 'info-enrichment',
  },
})
export class InfoEnrichmentComponent implements OnDestroy {
  private readonly state = inject(LibraryStateService);
  private readonly api = inject(BunApiBackendService);
  private readonly injector = inject(Injector);

  /** Last-fetched detail for the focused asset. Cleared on focus change. */
  readonly detail = signal<ApiAssetDetail | null>(null);

  /** Per-stage paused flag from GET /api/workers/status. Empty record
   * means "not yet fetched" — render as if not paused (so we don't show
   * the misleading "Worker paused" badge before we know). */
  private readonly workerPaused = signal<Partial<Record<ApiEnrichmentStage, boolean>>>({});

  /** Per-stage last error string from the most recent Re-* or override
   * click. Cleared on the next successful click for the same stage. */
  private readonly lastClickError = signal<Partial<Record<ApiEnrichmentStage, string>>>({});

  /** Per-stage flag set when the 30 s polling window expires without
   * `done_at` flipping. Tells the user the row is stuck rather than
   * actively in flight. Cleared on focus change and on the next click. */
  private readonly staleAfterRequeue = signal<Partial<Record<ApiEnrichmentStage, true>>>({});

  // ── Template-facing computeds ────────────────────────────────────────

  protected readonly showPlace = computed(() => {
    const d = this.detail();
    return d !== null && showPlaceSection(d);
  });

  protected readonly placeStatus = computed(() => {
    const d = this.detail();
    if (!d) return null;
    return stageStatus(d.enrichment.geocode, this.workerPaused().geocode === true);
  });

  protected readonly describeStatus = computed(() => {
    const d = this.detail();
    if (!d) return null;
    return stageStatus(d.enrichment.describe, this.workerPaused().describe === true);
  });

  protected readonly faceStatus = computed(() => {
    const d = this.detail();
    if (!d) return null;
    return stageStatus(d.enrichment.face, this.workerPaused().face === true);
  });

  protected readonly placeError = computed(() => this.lastClickError().geocode ?? null);
  protected readonly describeError = computed(() => this.lastClickError().describe ?? null);
  protected readonly faceError = computed(() => this.lastClickError().face ?? null);

  protected readonly placeStale = computed(() => this.staleAfterRequeue().geocode === true);
  protected readonly describeStale = computed(() => this.staleAfterRequeue().describe === true);
  protected readonly faceStale = computed(() => this.staleAfterRequeue().face === true);

  /** API id of the asset currently fetched. Recomputed from the focused
   * asset's local id via `state.apiIdFor`. */
  private readonly apiAssetId = computed(() => {
    const asset = this.state.focusedAsset();
    if (!asset) return null;
    return this.state.apiIdFor(asset.id) ?? null;
  });

  // ── Lifecycle plumbing ───────────────────────────────────────────────

  private detailSub: Subscription | null = null;
  private refreshTimer: ReturnType<typeof setInterval> | null = null;
  private refreshDeadline = 0;
  private refreshBaseline: ApiAssetDetail | null = null;
  private refreshStage: ApiEnrichmentStage | null = null;

  constructor() {
    this.fetchWorkerStatus();
    effect(() => {
      const apiId = this.apiAssetId();
      // Reset per-stage UI signals on focus change so stale state from
      // the previous asset doesn't leak through.
      this.lastClickError.set({});
      this.staleAfterRequeue.set({});
      this.detail.set(null);
      this.stopRefreshLoop();
      if (apiId) this.fetchDetail(apiId);
    });
  }

  ngOnDestroy(): void {
    this.detailSub?.unsubscribe();
    this.stopRefreshLoop();
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

  private fetchDetail(apiId: string): void {
    this.detailSub?.unsubscribe();
    this.detailSub = this.api.getAssetDetails(apiId).subscribe({
      next: (d) => this.detail.set(d),
      error: () => {
        // Swallow — the section just stays empty.
      },
    });
  }

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
          if (detailChanged(this.refreshBaseline, d)) {
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

  /** Refetch the detail once after a manual override (no polling — the
   * field went directly to Mongo, so the next read is enough). */
  private refetchAfterMutation(): void {
    const apiId = this.apiAssetId();
    if (!apiId) return;
    runInInjectionContext(this.injector, () => this.fetchDetail(apiId));
  }

  // ── Child event handlers ─────────────────────────────────────────────

  protected onPlaceSave(next: ApiPlace | null): void {
    const d = this.detail();
    if (!d) return;
    this.clearStageFeedback('geocode');
    this.api.setAssetPlaceOverride(d.id, next).subscribe({
      next: () => this.refetchAfterMutation(),
      error: () => this.setStageError('geocode', 'Failed to save — try again.'),
    });
  }

  protected onDescriptionSave(text: string | null): void {
    const d = this.detail();
    if (!d) return;
    this.clearStageFeedback('describe');
    this.api.setAssetDescriptionOverride(d.id, text).subscribe({
      next: () => this.refetchAfterMutation(),
      error: () => this.setStageError('describe', 'Failed to save — try again.'),
    });
  }

  protected onRequeue(stage: ApiEnrichmentStage): void {
    const d = this.detail();
    if (!d) return;
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
      error: () => this.setStageError(stage, 'Failed to requeue — try again.'),
    });
  }
}
