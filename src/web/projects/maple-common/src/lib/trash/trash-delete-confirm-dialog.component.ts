// TrashDeleteConfirmDialogComponent — "Delete Permanently" confirmation
// (#2652). Guards the genuinely unrecoverable action in the whole feature:
// once this confirms, the file is gone (`workers/trash-gc.ts`'s 30-day
// sweep does the same unlink for anything left in Trash, this just does it
// now). The message says so explicitly rather than reusing generic
// "delete" copy — states that this action cannot be undone.
//
// Rebuilt on `<mui-dialog>` (MW2, #3029) — replaces the hand-rolled
// backdrop/card markup and the `DestructiveConfirmDialogBase` mixin this
// component used to extend alongside `folder-tree/folder-trash-confirm-
// dialog.component.ts`: mui-dialog's `destructive` input now owns the same
// focus-Cancel-on-open + busy-guard + `alertdialog` role behavior that base
// class provided, so both dialogs migrated onto it and the base class was
// deleted.

import { ChangeDetectionStrategy, Component, computed, input, output } from '@angular/core';
import { MuiDialogComponent } from '../ui/dialog/mui-dialog.component';

@Component({
  selector: 'app-trash-delete-confirm-dialog',
  standalone: true,
  imports: [MuiDialogComponent],
  templateUrl: './trash-delete-confirm-dialog.component.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class TrashDeleteConfirmDialogComponent {
  /** Either one filename (single-item delete) or `"N items"` (bulk empty
   * Trash) — the caller decides which string reads best for the count. */
  readonly targetLabel = input.required<string>();
  readonly serverError = input<string | null>(null);
  readonly busy = input<boolean>(false);

  readonly confirmDelete = output<void>();
  readonly dismiss = output<void>();

  protected readonly message = computed(
    () =>
      `Permanently deletes ${this.targetLabel()} from disk. This action cannot be undone — there is no further Trash or recovery step after this.`,
  );
  protected readonly confirmLabel = computed(() =>
    this.busy() ? 'Deleting…' : 'Delete Permanently',
  );

  onConfirm(): void {
    this.confirmDelete.emit();
  }

  onDismiss(): void {
    this.dismiss.emit();
  }
}
