// DragMoveCollisionDialogComponent — Skip / Replace / Keep Both prompt for a
// drag-move/copy that collided with an existing file at the destination
// (#2644). Mirrors `folder-trash-confirm-dialog.component.ts`'s shape (one
// focused confirm-style card, cancel focused first) but with three actions
// instead of confirm/cancel, per the design doc's collision policy for
// user-initiated relocates.
//
// Always mounted directly (no `@defer`) in `browse-shell.component.html`
// — NOT `folder-tree.component.html`: it lives at the shell level so it
// stays reachable on phone, where the inline sidebar (and any
// `FolderTreeComponent` instance inside it) is torn down whenever the
// source-picker drawer is closed; see that file's own comment for the full
// reasoning. Safe to keep eager: this component only renders Skip/Replace/
// Keep Both buttons and emits events, it carries no server import of its
// own — only `DragMoveService` (reached through the `DragMoveCapability`
// token, not imported here) talks to the API.

import {
  AfterViewInit,
  ChangeDetectionStrategy,
  Component,
  ViewChild,
  input,
  output,
} from '@angular/core';
import type { DragMoveCollisionPolicy } from './drag-move-capability';
import { MuiButtonComponent } from '../ui/button/mui-button.component';

@Component({
  selector: 'app-drag-move-collision-dialog',
  standalone: true,
  imports: [MuiButtonComponent],
  templateUrl: './drag-move-collision-dialog.component.html',
  styleUrl: './drag-move-collision-dialog.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class DragMoveCollisionDialogComponent implements AfterViewInit {
  readonly filename = input.required<string>();

  readonly resolve = output<DragMoveCollisionPolicy>();

  @ViewChild('skipButton') private skipButtonRef?: MuiButtonComponent;

  ngAfterViewInit(): void {
    // Skip is the non-destructive default focus target — matches the trash
    // confirm dialog's "cancel focused first" convention for a prompt that
    // can otherwise overwrite a file (Replace).
    queueMicrotask(() => this.skipButtonRef?.focus());
  }

  onSkip(): void {
    this.resolve.emit('skip');
  }

  onReplace(): void {
    this.resolve.emit('replace');
  }

  onKeepBoth(): void {
    this.resolve.emit('keep-both');
  }

  onBackdropClick(): void {
    this.onSkip();
  }
}
