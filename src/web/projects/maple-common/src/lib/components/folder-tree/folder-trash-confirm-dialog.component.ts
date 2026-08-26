// FolderTrashConfirmDialogComponent — "Move to Trash" confirmation for the
// folder-tree context menu (#2643). Names the actual folder being trashed
// (never a generic "this folder") so the destructive action is unambiguous,
// matching the Apple sibling's `confirmationDialog` message (#2645).
//
// Rebuilt on `<mui-dialog>` (MW2, #3029) — see `trash/trash-delete-confirm-
// dialog.component.ts`'s identical note: both dialogs used to extend the
// now-deleted `DestructiveConfirmDialogBase`, and both migrated onto
// mui-dialog's own `destructive` handling (focus-Cancel-on-open, busy
// guard, `alertdialog` role) instead.

import { ChangeDetectionStrategy, Component, computed, input, output } from '@angular/core';
import { MuiDialogComponent } from '../../ui/dialog/mui-dialog.component';

@Component({
  selector: 'app-folder-trash-confirm-dialog',
  standalone: true,
  imports: [MuiDialogComponent],
  templateUrl: './folder-trash-confirm-dialog.component.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class FolderTrashConfirmDialogComponent {
  readonly folderLabel = input.required<string>();
  readonly serverError = input<string | null>(null);
  readonly busy = input<boolean>(false);

  readonly confirmTrash = output<void>();
  readonly dismiss = output<void>();

  protected readonly message = computed(
    () => `This moves "${this.folderLabel()}" and everything inside it to Trash.`,
  );
  protected readonly confirmLabel = computed(() => (this.busy() ? 'Moving…' : 'Move to Trash'));

  onConfirm(): void {
    this.confirmTrash.emit();
  }

  onDismiss(): void {
    this.dismiss.emit();
  }
}
