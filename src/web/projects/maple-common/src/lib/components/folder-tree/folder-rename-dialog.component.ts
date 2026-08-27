// FolderRenameDialogComponent — "Rename" prompt for the folder-tree context
// menu (#2643). A modal dialog rather than a row-embedded `<input>` — this
// matches how the Apple sibling (#2645) does it too (a `.alert` with a
// `TextField`, not a literal in-row DOM swap): "inline" here means "renaming
// this specific row via a lightweight, row-scoped prompt," not that the
// text field lives inside the row's markup. A modal also sidesteps the
// blur-cancels-a-request race a row-embedded input has (#2705 review):
// Cancel and the backdrop are both no-ops while `busy()`, so the dialog
// can't be dismissed out from under an in-flight request.

import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  ViewChild,
  AfterViewInit,
  computed,
  effect,
  input,
  linkedSignal,
  output,
} from '@angular/core';
import { validateFolderNameDraft } from './folder-name-validation';
import { MuiButtonComponent } from '../../ui/button/mui-button.component';

@Component({
  selector: 'app-folder-rename-dialog',
  standalone: true,
  imports: [MuiButtonComponent],
  templateUrl: './folder-rename-dialog.component.html',
  styleUrl: './folder-rename-dialog.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class FolderRenameDialogComponent implements AfterViewInit {
  readonly currentName = input.required<string>();
  readonly busy = input<boolean>(false);
  readonly serverError = input<string | null>(null);

  readonly rename = output<string>();
  readonly dismiss = output<void>();

  /** Defaults to the current name each time `currentName` changes (a fresh
   * dialog instance per #2643's "mount fresh" convention means this really
   * only runs once), but stays a normal writable signal once the user
   * types — `linkedSignal` rather than a constructor-time `.set()` because
   * signal inputs aren't guaranteed settled before the constructor body
   * runs. */
  readonly name = linkedSignal(() => this.currentName());
  /** Only the light pre-check — leaving the name unchanged is deliberately
   * NOT flagged as invalid here (that would show an error on a pristine,
   * untouched dialog). `onSubmit` treats an unchanged, otherwise-valid name
   * as an implicit cancel instead. */
  readonly validationMessage = computed(() => validateFolderNameDraft(this.name()));
  readonly isValid = computed(() => this.validationMessage() === null);

  @ViewChild('nameInput') private nameInputRef?: ElementRef<HTMLInputElement>;

  constructor() {
    // A rejected rename (collision or otherwise) re-selects the input so
    // the user can immediately retype and retry — the dialog stays open
    // and mounted (the caller never emits `closed` on error), but without
    // this the focus/selection from the initial mount is long gone by the
    // time the server responds.
    effect(() => {
      if (this.serverError() === null) return;
      const el = this.nameInputRef?.nativeElement;
      el?.focus();
      el?.select();
    });
  }

  ngAfterViewInit(): void {
    queueMicrotask(() => {
      const el = this.nameInputRef?.nativeElement;
      el?.focus();
      el?.select();
    });
  }

  onNameInput(value: string): void {
    this.name.set(value);
  }

  onSubmit(): void {
    if (!this.isValid() || this.busy()) return;
    const trimmed = this.name().trim();
    // Unchanged name — nothing to rename, and not an error. Treat Enter/
    // Rename here the same as Cancel rather than round-tripping a no-op
    // `/move` or showing a confusing "invalid name" message.
    if (trimmed === this.currentName()) {
      this.dismiss.emit();
      return;
    }
    this.rename.emit(trimmed);
  }

  onCancel(): void {
    if (this.busy()) return;
    this.dismiss.emit();
  }

  onBackdropClick(): void {
    this.onCancel();
  }
}
