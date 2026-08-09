// DestructiveConfirmDialogBase — the focus-management + busy-guard skeleton
// every "are you sure" dialog in maple-common shares: focus the Cancel
// button once the view is up (the platform convention for a destructive
// confirmation — matches the Apple sibling's `confirmationDialog` alert),
// and ignore Cancel/Confirm clicks while a request is already in flight.
//
// Extracted from `FolderTrashConfirmDialogComponent` (#2643) and
// `TrashDeleteConfirmDialogComponent` (#2652) — a fallow-audit-web
// duplication finding flagged the two as a 19-line byte-identical clone
// group. An `@Directive()` abstract base (Angular's supported pattern for
// sharing component behavior without a template) is the fix rather than a
// third copy: each concrete dialog keeps its own `input`/`output` names
// (`folderLabel`/`confirmTrash` vs. `targetLabel`/`confirmDelete` — the
// button labels and emitted events genuinely differ per dialog), it just
// delegates the guard/focus mechanics here.

import { AfterViewInit, Directive, ElementRef, ViewChild, input } from '@angular/core';

@Directive()
export abstract class DestructiveConfirmDialogBase implements AfterViewInit {
  readonly busy = input<boolean>(false);

  // `serverError` is deliberately NOT declared here even though every
  // subclass has one: this base class's own template-free body never reads
  // it, and each concrete dialog's `.html` does — a base-class `input()`
  // read only from a SUBCLASS's template reads as unused-and-dead to
  // fallow's per-class analysis. Each subclass declares its own
  // `readonly serverError = input<string | null>(null);` instead.

  @ViewChild('cancelButton') protected cancelButtonRef?: ElementRef<HTMLButtonElement>;

  ngAfterViewInit(): void {
    queueMicrotask(() => this.cancelButtonRef?.nativeElement.focus());
  }

  /** Run `dismiss` unless a request is already in flight — the shared body
   * of every dialog's `onCancel`/`onBackdropClick`. */
  protected guardedCancel(dismiss: () => void): void {
    if (this.busy()) return;
    dismiss();
  }

  /** Run `confirm` unless a request is already in flight — the shared body
   * of every dialog's `onConfirm`. */
  protected guardedConfirm(confirm: () => void): void {
    if (this.busy()) return;
    confirm();
  }
}
