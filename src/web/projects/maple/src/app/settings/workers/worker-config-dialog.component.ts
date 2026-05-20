// WorkerConfigDialogComponent — modal for per-stage runtime config.
//
// Opened from WorkersComponent when the operator clicks the ⚙ cog on a row.
// Displays the current live values (from the most recent status poll) and
// allows editing concurrency / pollIntervalMs / batchSize / maxAttempts.
// PATCHes /api/workers/:name/config on Save; emits `saved` on success.
// Emits `cancelled` (or the parent closes the dialog) on Cancel / Escape.

import {
  ChangeDetectionStrategy,
  Component,
  HostListener,
  OnInit,
  inject,
  input,
  output,
  signal,
} from '@angular/core';
import { ReactiveFormsModule, FormBuilder, Validators } from '@angular/forms';
import {
  WorkersApiService,
  type StageStatus,
  type WorkerConfig,
} from '@maple-common';

@Component({
  standalone: true,
  selector: 'maple-worker-config-dialog',
  imports: [ReactiveFormsModule],
  templateUrl: './worker-config-dialog.component.html',
  styleUrl: './worker-config-dialog.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class WorkerConfigDialogComponent implements OnInit {
  private readonly api = inject(WorkersApiService);
  private readonly fb = inject(FormBuilder);

  /** The stage this dialog is editing. */
  readonly stage = input.required<StageStatus>();
  /** Persisted config snapshot taken when the dialog opens. The parent polls
   * status every ~2s and re-emits a fresh config object each tick; we
   * deliberately ignore those mid-dialog updates so the operator's in-progress
   * edits aren't wiped out from under them. (Dialog is destroyed/recreated on
   * every open, so the next open re-snapshots the latest values.) */
  readonly config = input.required<WorkerConfig>();

  /** Fires with the returned config on a successful PATCH. */
  readonly saved = output<WorkerConfig>();
  /** Fires when the user dismisses without saving. */
  readonly cancelled = output<void>();

  readonly form = this.fb.nonNullable.group({
    concurrency:    [4, [Validators.required, Validators.min(1), Validators.max(32)]],
    pollIntervalMs: [1000, [Validators.required, Validators.min(100), Validators.max(60000)]],
    batchSize:      [10, [Validators.required, Validators.min(1), Validators.max(100)]],
    maxAttempts:    [5, [Validators.required, Validators.min(1), Validators.max(20)]],
  });

  readonly saveError = signal<string | null>(null);
  readonly saving = signal(false);

  ngOnInit(): void {
    const c = this.config();
    this.form.setValue({
      concurrency:    c.concurrency,
      pollIntervalMs: c.pollIntervalMs,
      batchSize:      c.batchSize,
      maxAttempts:    c.maxAttempts,
    });
  }

  @HostListener('document:keydown.escape')
  onEscape(): void {
    this.cancelled.emit();
  }

  save(): void {
    if (this.form.invalid) return;
    this.saving.set(true);
    this.saveError.set(null);
    const name = this.stage().name;
    this.api.patchConfig(name, this.form.getRawValue()).subscribe({
      next: (res) => {
        this.saving.set(false);
        // Fall back to the submitted form values if the server doesn't echo
        // the config back (e.g. DB unavailable path returns null). Merge in
        // the non-form fields (paused, last_seen_target_version) from the
        // current config so the emitted value satisfies WorkerConfig fully.
        const returnedConfig: WorkerConfig = res.config ?? {
          ...this.form.getRawValue(),
          paused: this.config().paused,
          last_seen_target_version: this.config().last_seen_target_version,
        };
        this.saved.emit(returnedConfig);
      },
      error: (err) => {
        this.saving.set(false);
        this.saveError.set(err?.error?.error ?? err?.message ?? 'Save failed.');
      },
    });
  }

  cancel(): void {
    this.cancelled.emit();
  }
}
