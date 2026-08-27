// FolderNewFolderDialogComponent — "New Folder" name prompt for the
// folder-tree context menu (#2643). Mounted fresh each time it's shown (the
// parent gates it behind `@if`), so all state resets on its own — no
// visibility-toggle plumbing needed.

import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  ViewChild,
  AfterViewInit,
  computed,
  input,
  output,
  signal,
} from '@angular/core';
import { validateFolderNameDraft } from './folder-name-validation';
import { MuiButtonComponent } from '../../ui/button/mui-button.component';

@Component({
  selector: 'app-folder-new-folder-dialog',
  standalone: true,
  imports: [MuiButtonComponent],
  templateUrl: './folder-new-folder-dialog.component.html',
  styleUrl: './folder-new-folder-dialog.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class FolderNewFolderDialogComponent implements AfterViewInit {
  /** Display name of the folder the new subfolder will be created inside. */
  readonly parentLabel = input.required<string>();
  readonly busy = input<boolean>(false);
  /** Server-side rejection (authoritative — the Rust filename-validation
   * engine catches reserved names, trailing dots, etc. that the client-side
   * pre-check below doesn't). */
  readonly serverError = input<string | null>(null);

  readonly create = output<string>();
  readonly dismiss = output<void>();

  readonly name = signal('');
  readonly validationMessage = computed(() => validateFolderNameDraft(this.name()));
  readonly isValid = computed(() => this.validationMessage() === null);

  @ViewChild('nameInput') private nameInputRef?: ElementRef<HTMLInputElement>;

  ngAfterViewInit(): void {
    queueMicrotask(() => this.nameInputRef?.nativeElement.focus());
  }

  onNameInput(value: string): void {
    this.name.set(value);
  }

  onSubmit(): void {
    if (!this.isValid() || this.busy()) return;
    this.create.emit(this.name().trim());
  }

  onCancel(): void {
    if (this.busy()) return;
    this.dismiss.emit();
  }

  onBackdropClick(): void {
    this.onCancel();
  }
}
