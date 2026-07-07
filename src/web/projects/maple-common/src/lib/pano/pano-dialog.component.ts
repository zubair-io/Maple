// PanoDialogComponent — options dialog for panorama stitching (#1231).
//
// Shows when the user clicks "Merge to panorama…" with ≥2 assets selected.
// Renders stitch options, submits the job, and tracks progress via polling.
//
// State machine:
//   idle → submitting → polling → done | error
//
// The dialog is self-contained: it reads the pano config to decide which
// controls to show (strategy hidden when strategySupported=false), submits,
// polls every 2s, and navigates to the new asset or shows the error report.
//
// Parent binds [visible] and [assetIds] and listens for (dismiss).

import {
  ChangeDetectionStrategy,
  Component,
  OnDestroy,
  computed,
  inject,
  input,
  output,
  signal,
  effect,
} from '@angular/core';
import { HttpErrorResponse } from '@angular/common/http';
import { Router } from '@angular/router';
import { Subscription, interval } from 'rxjs';
import { switchMap, takeWhile } from 'rxjs/operators';
import {
  PanoService,
  PanoConfig,
  PanoRetention,
  PanoLocalAlign,
  PanoStrategy,
  PanoJobView,
} from '../api/pano.service';
import { LibraryStateService } from '../state/library-state.service';
import { viewRouteCommands } from '../addressing/route-address';

type DialogPhase =
  | 'idle'
  | 'loading-config'
  | 'options'
  | 'submitting'
  | 'polling'
  | 'done'
  | 'error';

@Component({
  selector: 'app-pano-dialog',
  standalone: true,
  templateUrl: './pano-dialog.component.html',
  styleUrl: './pano-dialog.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class PanoDialogComponent implements OnDestroy {
  // ── inputs / outputs ───────────────────────────────────────────────────────
  readonly visible = input<boolean>(false);
  /** Asset ids selected in the grid — must have ≥ 2 before opening. */
  readonly assetIds = input<string[]>([]);
  /** Emitted when the dialog should close (done, error, or user cancel). */
  readonly dismiss = output<void>();

  // ── services ───────────────────────────────────────────────────────────────
  private readonly pano = inject(PanoService);
  private readonly state = inject(LibraryStateService);
  private readonly router = inject(Router);

  // ── state ─────────────────────────────────────────────────────────────────
  readonly phase = signal<DialogPhase>('idle');
  readonly config = signal<PanoConfig | null>(null);
  readonly errorMessage = signal<string>('');
  /** Structured error code from the server (e.g. 'pano_not_provisioned' or
   * 'pano_job_running'). Used by the template to switch on a code rather than
   * matching substrings of the localised error message. */
  readonly errorCode = signal<string>('');
  readonly job = signal<PanoJobView | null>(null);

  // ── option model (two-way signals) ────────────────────────────────────────
  readonly retention = signal<PanoRetention>('keep');
  readonly localAlign = signal<PanoLocalAlign>('mesh');
  readonly strategy = signal<PanoStrategy>('auto');

  readonly strategySupported = computed(() => this.config()?.strategy_supported ?? false);
  readonly assetCount = computed(() => this.assetIds().length);

  /** Human-readable progress label derived from the job stage counter. */
  readonly progressLabel = computed(() => {
    const j = this.job();
    if (!j) return 'Starting…';
    const stageLabels = [
      'Decoding frames',
      'Detecting keypoints',
      'Building match graph',
      'Refining matches',
      'Bundle adjustment',
      'Writing output',
    ];
    const idx = Math.min(j.progress.current, stageLabels.length) - 1;
    return idx >= 0 ? stageLabels[idx] : 'Starting…';
  });

  private pollSub: Subscription | null = null;

  constructor() {
    // Load config when the dialog opens.
    effect(() => {
      if (this.visible() && this.phase() === 'idle') {
        this._loadConfig();
      }
      if (!this.visible()) {
        this.phase.set('idle');
        this.config.set(null);
        this.errorMessage.set('');
        this.errorCode.set('');
        this.job.set(null);
        this._stopPolling();
      }
    });
  }

  ngOnDestroy(): void {
    this._stopPolling();
  }

  // ── actions ───────────────────────────────────────────────────────────────

  private _loadConfig(): void {
    this.phase.set('loading-config');
    this.pano.getConfig().subscribe({
      next: (cfg) => {
        this.config.set(cfg);
        this.phase.set('options');
      },
      error: () => {
        this.errorMessage.set('Could not load pano configuration. Check Settings > Pano.');
        this.phase.set('error');
      },
    });
  }

  onSubmit(): void {
    const localIds = this.assetIds();
    if (localIds.length < 2) return;

    // ── Resolve the library ObjectId ──────────────────────────────────────
    // `selectedSourceId` is `fs:<absPath>` in self-hosted browse mode —
    // NOT a MongoDB ObjectId. `currentRegisteredFolder()` does a
    // longest-prefix match against the registered library roots and returns
    // the ApiFolder whose `id` IS the hex ObjectId the handler validates.
    const folder = this.state.currentRegisteredFolder();
    if (!folder) {
      this.errorCode.set('');
      this.errorMessage.set(
        'No registered library is selected. Pick a library folder in the sidebar first.',
      );
      this.phase.set('error');
      return;
    }
    const libraryId = folder.id;

    // ── Resolve asset references ──────────────────────────────────────────
    // Strategy: always send absolute paths so the server can resolve the
    // current index state at merge time (avoids the stale-client-map false-
    // negative). The client's `apiIdFor` map is populated from a prior browse
    // fetch and may not reflect recently-indexed files.
    //
    // We also include any known MongoDB ObjectIds as an optimisation — the
    // server accepts both and prefers the path for freshness.
    //
    // For self-hosted FS-walk assets the local id is `fs:<absPath>`, so
    // `absPathFor(localId)` returns the absolute path. When no abs-path is
    // available (e.g. a cloud-hosted asset already carrying an API id) we
    // fall back to the API id alone.
    // Per asset, send the best single reference: prefer the absolute path
    // (the server resolves it fresh, avoiding the stale-id false-negative) and
    // fall back to the API id only when there is no path. We never send BOTH a
    // path and an id for the same asset — a stale cached id alongside a fresh
    // path would make the server stitch a duplicate (or a 404'd) document.
    const assetPaths: string[] = [];
    const assetIds: string[] = [];
    const unreferenced: string[] = [];

    for (const localId of localIds) {
      const absPath = this.state.absPathFor(localId);
      if (absPath) {
        assetPaths.push(absPath);
        continue;
      }
      const apiId = this.state.apiIdFor(localId);
      if (apiId) {
        assetIds.push(apiId);
        continue;
      }
      unreferenced.push(localId);
    }

    // Fail fast if ANY selected asset cannot be referenced. Dropping it
    // silently would stitch fewer images than the user picked, with no
    // feedback — surface a clear error instead.
    if (unreferenced.length > 0) {
      this.errorCode.set('assets_not_indexed');
      this.errorMessage.set(
        `${unreferenced.length} of the selected ` +
          `${unreferenced.length === 1 ? 'image' : 'images'} could not be located ` +
          'on disk or in the index. Try re-opening the folder and selecting again.',
      );
      this.phase.set('error');
      return;
    }

    this.phase.set('submitting');
    const options = {
      retention: this.retention(),
      localAlign: this.localAlign(),
      ...(this.strategySupported() ? { strategy: this.strategy() } : {}),
    };

    this.pano
      .stitch({
        ...(assetPaths.length > 0 ? { assetPaths } : {}),
        ...(assetIds.length > 0 ? { assetIds } : {}),
        libraryId,
        options,
      })
      .subscribe({
        next: ({ id, indexing }) => {
          if (indexing && indexing > 0) {
            // Server indexed files on-demand before queuing the job.
            // The job is now queued; transition directly to polling.
            this.errorMessage.set('');
          }
          this.phase.set('polling');
          this._startPolling(id);
        },
        error: (err: HttpErrorResponse) => {
          const code: string = err.error?.error ?? '';
          this.errorCode.set(code);
          if (err.status === 409 && code === 'pano_not_provisioned') {
            this.errorMessage.set(err.error.message);
          } else if (err.status === 409 && code === 'pano_job_running') {
            this.errorMessage.set(
              `A panorama job is already running or queued (job ${err.error.jobId ?? ''}). Wait for it to finish.`,
            );
          } else {
            this.errorMessage.set(err.error?.message ?? 'Failed to start panorama job.');
          }
          this.phase.set('error');
        },
      });
  }

  onCancel(): void {
    const j = this.job();
    if (j && this.phase() === 'polling') {
      this.pano.cancelJob(j.id).subscribe();
    }
    this._stopPolling();
    this.dismiss.emit();
  }

  onViewResult(): void {
    const j = this.job();
    const assetId = j?.result?.outputAssetId;
    if (assetId) {
      void this.router.navigate(viewRouteCommands(assetId));
    }
    this.dismiss.emit();
  }

  onClose(): void {
    this.dismiss.emit();
  }

  onBackdropClick(): void {
    if (this.phase() !== 'submitting' && this.phase() !== 'polling') {
      this.dismiss.emit();
    }
  }

  // ── polling ───────────────────────────────────────────────────────────────

  private _startPolling(jobId: string): void {
    this._stopPolling();
    this.pollSub = interval(2_000)
      .pipe(
        switchMap(() => this.pano.getJob(jobId)),
        takeWhile((j) => j.status === 'queued' || j.status === 'running', true),
      )
      .subscribe({
        next: (j) => {
          this.job.set(j);
          if (j.status === 'done') {
            this.phase.set('done');
            this._stopPolling();
          } else if (j.status === 'failed' || j.status === 'cancelled') {
            this.errorMessage.set(
              j.status === 'cancelled'
                ? 'Panorama job was cancelled.'
                : (j.error ?? 'Panorama job failed.'),
            );
            this.phase.set('error');
            this._stopPolling();
          }
        },
        error: () => {
          this.errorMessage.set('Lost contact with the server while polling job status.');
          this.phase.set('error');
        },
      });
  }

  private _stopPolling(): void {
    this.pollSub?.unsubscribe();
    this.pollSub = null;
  }
}
