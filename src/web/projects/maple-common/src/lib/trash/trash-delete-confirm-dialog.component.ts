// TrashDeleteConfirmDialogComponent — "Delete Permanently" confirmation
// (#2652). Guards the genuinely unrecoverable action in the whole feature:
// once this confirms, the file is gone (`workers/trash-gc.ts`'s 30-day
// sweep does the same unlink for anything left in Trash, this just does it
// now). The message says so explicitly rather than reusing generic
// "delete" copy — states that this action cannot be undone.
//
// Extends `DestructiveConfirmDialogBase` for the focus-management + busy-
// guard mechanics shared with `folder-tree/folder-trash-confirm-dialog
// .component.ts` — see that file's module doc.

import { ChangeDetectionStrategy, Component, input, output } from '@angular/core';
import { DestructiveConfirmDialogBase } from '../components/confirm-dialog/destructive-confirm-dialog-base';

@Component({
  selector: 'app-trash-delete-confirm-dialog',
  standalone: true,
  templateUrl: './trash-delete-confirm-dialog.component.html',
  styleUrl: './trash-delete-confirm-dialog.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class TrashDeleteConfirmDialogComponent extends DestructiveConfirmDialogBase {
  /** Either one filename (single-item delete) or `"N items"` (bulk empty
   * Trash) — the caller decides which string reads best for the count. */
  readonly targetLabel = input.required<string>();
  readonly serverError = input<string | null>(null);

  readonly confirmDelete = output<void>();
  readonly dismiss = output<void>();

  onCancel(): void {
    this.guardedCancel(() => this.dismiss.emit());
  }

  onConfirm(): void {
    this.guardedConfirm(() => this.confirmDelete.emit());
  }

  onBackdropClick(): void {
    this.onCancel();
  }
}
