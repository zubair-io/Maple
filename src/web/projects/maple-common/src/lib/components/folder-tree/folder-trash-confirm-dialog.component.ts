// FolderTrashConfirmDialogComponent — "Move to Trash" confirmation for the
// folder-tree context menu (#2643). Names the actual folder being trashed
// (never a generic "this folder") so the destructive action is unambiguous,
// matching the Apple sibling's `confirmationDialog` message (#2645).
//
// Extends `DestructiveConfirmDialogBase` for the focus-management + busy-
// guard mechanics shared with `trash/trash-delete-confirm-dialog.component
// .ts` (#2652) — see that base class's module doc for why this was
// extracted (a fallow-audit-web duplication finding).

import { ChangeDetectionStrategy, Component, input, output } from '@angular/core';
import { DestructiveConfirmDialogBase } from '../confirm-dialog/destructive-confirm-dialog-base';

@Component({
  selector: 'app-folder-trash-confirm-dialog',
  standalone: true,
  templateUrl: './folder-trash-confirm-dialog.component.html',
  styleUrl: './folder-trash-confirm-dialog.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class FolderTrashConfirmDialogComponent extends DestructiveConfirmDialogBase {
  readonly folderLabel = input.required<string>();
  readonly serverError = input<string | null>(null);

  readonly confirmTrash = output<void>();
  readonly dismiss = output<void>();

  onCancel(): void {
    this.guardedCancel(() => this.dismiss.emit());
  }

  onConfirm(): void {
    this.guardedConfirm(() => this.confirmTrash.emit());
  }

  onBackdropClick(): void {
    this.onCancel();
  }
}
