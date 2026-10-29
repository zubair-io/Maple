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
// Quick preview (#4580): while the options are open and the binary supports
// it, a low-resolution preview is requested and re-requested (debounced) on
// every option change (`PanoPreviewStore`). "Create panorama" hands the last
// finished preview to the stitch as `alignmentFrom`, so the full stitch does
// not repeat feature matching.
//
// Parent binds [visible] and [assetIds] and listens for (dismiss) and (created).

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
  untracked,
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
  PanoStitchRequest,
} from '../api/pano.service';
import { PanoPreviewStore } from './pano-preview.store';
import { panoProgressFraction, panoProgressLabel } from './pano-progress';
import { LibraryStateService } from '../state/library-state.service';
import { viewRouteCommands } from '../addressing/route-address';
import { MuiButtonComponent } from '../ui/button/mui-button.component';

type DialogPhase =
  | 'idle'
  | 'loading-config'
  | 'options'
  | 'submitting'
  | 'polling'
  | 'done'
  | 'error';

const SETTINGS_FIXABLE_ERRORS: ReadonlySet<string> = new Set([
  'pano_not_provisioned',
  'pano_cli_outdated',
]);

const DEFAULT_RETENTION: PanoRetention = 'keep';
const DEFAULT_LOCAL_ALIGN: PanoLocalAlign = 'mesh';
const DEFAULT_STRATEGY: PanoStrategy = 'auto';

function stitchErrorMessage(err: HttpErrorResponse, code: string): string {
  if (err.status === 409 && SETTINGS_FIXABLE_ERRORS.has(code)) return err.error.message;
  if (err.status === 409 && code === 'pano_job_running') {
    return 'A panorama is already being merged. Wait for it to finish, then try again.';
  }
  return err.error?.message ?? 'Failed to start panorama job.';
}

@Component({
  selector: 'app-pano-dialog',
  standalone: true,
  imports: [MuiButtonComponent],
  providers: [PanoPreviewStore],
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
  /** Emitted once a stitch finishes and its panorama has been imported. */
  readonly created = output<void>();

  // ── services ───────────────────────────────────────────────────────────────
  private readonly pano = inject(PanoService);
  private readonly state = inject(LibraryStateService);
  private readonly router = inject(Router);
  readonly preview = inject(PanoPreviewStore);

  // ── state ─────────────────────────────────────────────────────────────────
  readonly phase = signal<DialogPhase>('idle');
  readonly config = signal<PanoConfig | null>(null);
  readonly errorMessage = signal<string>('');
  /** Structured error code from the server (e.g. 'pano_not_provisioned' or
   * 'pano_job_running'). Used by the template to switch on a code rather than
   * matching substrings of the localised error message. */
  readonly errorCode = signal<string>('');
  readonly settingsFixable = computed(() => SETTINGS_FIXABLE_ERRORS.has(this.errorCode()));
  readonly job = signal<PanoJobView | null>(null);
  readonly stitchMatcherNote = computed(() => this.job()?.result?.matcherNote ?? null);

  // ── option model (two-way signals) ────────────────────────────────────────
  readonly retention = signal<PanoRetention>(DEFAULT_RETENTION);
  readonly localAlign = signal<PanoLocalAlign>(DEFAULT_LOCAL_ALIGN);
  readonly strategy = signal<PanoStrategy>(DEFAULT_STRATEGY);

  readonly strategySupported = computed(() => this.config()?.strategy_supported ?? false);
  readonly previewSupported = computed(() => this.config()?.preview_supported ?? false);
  readonly assetCount = computed(() => this.assetIds().length);

  /** Human-readable progress label derived from the job's stage progress. */
  readonly progressLabel = computed(() => panoProgressLabel(this.job()?.progress));
  readonly progressFraction = computed(() => panoProgressFraction(this.job()?.progress));

  readonly previewLabel = computed(() => {
    const run = this.preview.run();
    return run.kind === 'running' ? panoProgressLabel(run.progress) : '';
  });
  readonly previewFraction = computed(() => {
    const run = this.preview.run();
    return run.kind === 'running' ? panoProgressFraction(run.progress) : null;
  });

  private pollSub: Subscription | null = null;
  /** Bumped whenever the dialog goes away, so a stitch response that lands
   * afterwards knows nobody is watching its job. */
  private submitGeneration = 0;

  constructor() {
    // Load config when the dialog opens.
    effect(() => {
      if (this.visible() && this.phase() === 'idle') {
        this._loadConfig();
      }
      if (!this.visible()) {
        untracked(() => this.preview.dispose());
        this.phase.set('idle');
        this.config.set(null);
        this.errorMessage.set('');
        this.errorCode.set('');
        this.job.set(null);
        this.retention.set(DEFAULT_RETENTION);
        this.localAlign.set(DEFAULT_LOCAL_ALIGN);
        this.strategy.set(DEFAULT_STRATEGY);
        this._abandonSubmit();
        this._stopPolling();
      }
    });

    // Re-preview whenever an option changes while the options are open.
    effect(() => {
      if (this.phase() !== 'options' || !this.previewSupported()) return;
      const options = this.options();
      untracked(() => {
        const built = this.buildRequest(options);
        if ('request' in built) this.preview.request(built.request);
      });
    });
  }

  ngOnDestroy(): void {
    this._abandonSubmit();
    this._stopPolling();
  }

  private options(): PanoStitchRequest['options'] {
    return {
      retention: this.retention(),
      localAlign: this.localAlign(),
      ...(this.strategySupported() ? { strategy: this.strategy() } : {}),
    };
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

  /**
   * The stitch request for the current selection, or the error to show.
   *
   * `selectedSourceId` is `fs:<absPath>` in self-hosted browse mode — not a
   * server id — so the library comes from `currentRegisteredFolder()`, a
   * longest-prefix match against the registered roots. Per asset the best
   * single reference is sent: the absolute path (the server resolves it fresh,
   * avoiding the stale-id false negative) or, only when there is no path, the
   * API id. Never both: a stale cached id beside a fresh path would make the
   * server stitch a duplicate (or a 404'd) document.
   */
  private buildRequest(
    options: PanoStitchRequest['options'],
  ): { request: PanoStitchRequest } | { errorCode: string; errorMessage: string } {
    const folder = this.state.currentRegisteredFolder();
    if (!folder) {
      return {
        errorCode: '',
        errorMessage:
          'No registered library is selected. Pick a library folder in the sidebar first.',
      };
    }
    const refs = this.assetIds().map((localId) => ({
      localId,
      absPath: this.state.absPathFor(localId),
      apiId: this.state.apiIdFor(localId),
    }));
    const assetPaths = refs.flatMap((r) => (r.absPath ? [r.absPath] : []));
    const assetIds = refs.flatMap((r) => (!r.absPath && r.apiId ? [r.apiId] : []));
    const unreferenced = refs.filter((r) => !r.absPath && !r.apiId).length;
    // Dropping an unreferenced asset would silently stitch fewer images than
    // the user picked.
    if (unreferenced > 0) {
      return {
        errorCode: 'assets_not_indexed',
        errorMessage:
          `${unreferenced} of the selected ` +
          `${unreferenced === 1 ? 'image' : 'images'} could not be located ` +
          'on disk or in the index. Try re-opening the folder and selecting again.',
      };
    }
    return {
      request: {
        ...(assetPaths.length > 0 ? { assetPaths } : {}),
        ...(assetIds.length > 0 ? { assetIds } : {}),
        libraryId: folder.id,
        options,
      },
    };
  }

  onSubmit(): void {
    if (this.assetIds().length < 2) return;
    const built = this.buildRequest(this.options());
    if (!('request' in built)) {
      this.errorCode.set(built.errorCode);
      this.errorMessage.set(built.errorMessage);
      this.phase.set('error');
      return;
    }

    const alignmentFrom = this.preview.alignmentFrom();
    this.preview.cancel();
    this.phase.set('submitting');
    const generation = this.submitGeneration;
    this.pano.stitch({ ...built.request, ...(alignmentFrom ? { alignmentFrom } : {}) }).subscribe({
      next: ({ id }) => {
        if (generation !== this.submitGeneration) {
          this.pano.cancelJob(id).subscribe();
          return;
        }
        this.errorMessage.set('');
        this.phase.set('polling');
        this._startPolling(id);
      },
      error: (err: HttpErrorResponse) => {
        if (generation !== this.submitGeneration) return;
        const code: string = err.error?.error ?? '';
        this.errorCode.set(code);
        this.errorMessage.set(stitchErrorMessage(err, code));
        this.phase.set('error');
      },
    });
  }

  onCancel(): void {
    const j = this.job();
    if (j && this.phase() === 'polling') {
      this.pano.cancelJob(j.id).subscribe();
    }
    this.preview.cancel();
    this._abandonSubmit();
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
            this.created.emit();
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

  private _abandonSubmit(): void {
    this.submitGeneration += 1;
  }

  private _stopPolling(): void {
    this.pollSub?.unsubscribe();
    this.pollSub = null;
  }
}
