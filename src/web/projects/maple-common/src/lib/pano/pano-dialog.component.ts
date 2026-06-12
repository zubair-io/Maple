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

    // ── Resolve asset ObjectIds ───────────────────────────────────────────
    // In self-hosted browse mode the grid gives assets local ids like
    // `fs:<absPath>`. The server's assets collection uses MongoDB ObjectIds.
    // `apiIdFor` maps local IDs → persisted `_id` hex (populated by the
    // discover watcher after indexing). If an asset has no mapping yet it is
    // not in the assets collection and the job handler would reject it.
    //
    // Gate: require all selected assets to have a resolved API id. When some
    // are not yet indexed we surface a clear error rather than sending ids
    // the server will reject. This is the honest design constraint — the
    // "Merge to panorama" action requires persisted assets.
    const resolvedIds: string[] = [];
    for (const localId of localIds) {
      const apiId = this.state.apiIdFor(localId);
      if (!apiId) {
        this.errorCode.set('assets_not_indexed');
        this.errorMessage.set(
          'One or more selected images have not been indexed yet. ' +
            'Wait for the indexer to finish scanning, then try again.',
        );
        this.phase.set('error');
        return;
      }
      resolvedIds.push(apiId);
    }

    this.phase.set('submitting');
    const options = {
      retention: this.retention(),
      localAlign: this.localAlign(),
      ...(this.strategySupported() ? { strategy: this.strategy() } : {}),
    };

    this.pano.stitch({ assetIds: resolvedIds, libraryId, options }).subscribe({
      next: ({ id }) => {
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
      void this.router.navigate(['/library/editor', assetId]);
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
