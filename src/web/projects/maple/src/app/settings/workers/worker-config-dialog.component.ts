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
  effect,
  inject,
  input,
  output,
} from '@angular/core';
import { ReactiveFormsModule, FormBuilder, Validators } from '@angular/forms';
import {
  WorkersApiService,
  type StageState,
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
export class WorkerConfigDialogComponent {
  private readonly api = inject(WorkersApiService);
  private readonly fb = inject(FormBuilder);

  /** The stage this dialog is editing. Re-syncs form values when it changes. */
  readonly stage = input.required<StageState>();
  /** Current persisted config from the last status poll. */
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

  readonly saveError = { value: null as string | null };
  readonly saving = { value: false };

  constructor() {
    // Re-sync form whenever the config input signal changes.
    effect(() => {
      const c = this.config();
      this.form.setValue({
        concurrency:    c.concurrency,
        pollIntervalMs: c.pollIntervalMs,
        batchSize:      c.batchSize,
        maxAttempts:    c.maxAttempts,
      });
    });
  }

  save(): void {
    if (this.form.invalid) return;
    this.saving.value = true;
    this.saveError.value = null;
    const name = this.stage().name;
    this.api.patchConfig(name, this.form.getRawValue()).subscribe({
      next: (res) => {
        this.saving.value = false;
        this.saved.emit(res.config);
      },
      error: (err) => {
        this.saving.value = false;
        this.saveError.value = err?.error?.error ?? err?.message ?? 'Save failed.';
      },
    });
  }

  cancel(): void {
    this.cancelled.emit();
  }
}
