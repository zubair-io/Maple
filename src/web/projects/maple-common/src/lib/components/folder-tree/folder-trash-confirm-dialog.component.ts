// FolderTrashConfirmDialogComponent — "Move to Trash" confirmation for the
// folder-tree context menu (#2643). Names the actual folder being trashed
// (never a generic "this folder") so the destructive action is unambiguous,
// matching the Apple sibling's `confirmationDialog` message (#2645).

import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  ViewChild,
  AfterViewInit,
  input,
  output,
} from '@angular/core';

@Component({
  selector: 'app-folder-trash-confirm-dialog',
  standalone: true,
  templateUrl: './folder-trash-confirm-dialog.component.html',
  styleUrl: './folder-trash-confirm-dialog.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class FolderTrashConfirmDialogComponent implements AfterViewInit {
  readonly folderLabel = input.required<string>();
  readonly busy = input<boolean>(false);
  readonly serverError = input<string | null>(null);

  readonly confirmTrash = output<void>();
  readonly dismiss = output<void>();

  @ViewChild('cancelButton') private cancelButtonRef?: ElementRef<HTMLButtonElement>;

  ngAfterViewInit(): void {
    // Cancel is the default focus target for a destructive confirmation —
    // matches the platform convention the Apple sibling's alert follows.
    queueMicrotask(() => this.cancelButtonRef?.nativeElement.focus());
  }

  onCancel(): void {
    if (this.busy()) return;
    this.dismiss.emit();
  }

  onConfirm(): void {
    if (this.busy()) return;
    this.confirmTrash.emit();
  }

  onBackdropClick(): void {
    this.onCancel();
  }
}
