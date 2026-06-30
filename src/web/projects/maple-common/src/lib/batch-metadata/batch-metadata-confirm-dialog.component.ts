// batch-metadata-confirm-dialog.component.ts — confirm/preview step (#1606).
// Shows a summary of what will change before committing the batch write.

import { ChangeDetectionStrategy, Component, input, output } from '@angular/core';

@Component({
  selector: 'app-batch-metadata-confirm-dialog',
  standalone: true,
  templateUrl: './batch-metadata-confirm-dialog.component.html',
  styleUrl: './batch-metadata-confirm-dialog.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class BatchMetadataConfirmDialogComponent {
  readonly visible = input<boolean>(false);
  readonly assetCount = input<number>(0);
  /** Human-readable labels for the fields that will be written. */
  readonly touchedFields = input<string[]>([]);
  /** True while the HTTP request is in-flight. */
  readonly applying = input<boolean>(false);
  /** Per-asset failures reported after a partial-success response. */
  readonly errors = input<Array<{ address: string; error: string }>>([]);

  readonly confirm = output<void>();
  readonly cancel = output<void>();

  onConfirm(): void {
    this.confirm.emit();
  }

  onCancel(): void {
    this.cancel.emit();
  }
}
