// MuiInlineRenameField — Maple UI Molecules-L1 (unified-component-catalog.md
// §2.1). Edit-in-place name: renders as static text until activated, then
// swaps to an Input with a commit/cancel affordance. Built from Input + Text.

import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  ViewChild,
  input,
  model,
  output,
  signal,
} from '@angular/core';
import { MuiIconComponent } from '../icon/mui-icon.component';
import { MuiInputComponent } from '../input/mui-input.component';
import { MuiTextComponent } from '../text/mui-text.component';

@Component({
  selector: 'mui-inline-rename-field',
  standalone: true,
  imports: [MuiIconComponent, MuiInputComponent, MuiTextComponent],
  templateUrl: './mui-inline-rename-field.component.html',
  host: { class: 'inline-block max-w-full' },
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class MuiInlineRenameFieldComponent {
  readonly value = model<string>('');
  readonly ariaLabel = input<string>('Name');
  readonly disabled = input<boolean>(false);

  /** Fires with the new name once a rename is committed (Enter or blur with a change). */
  readonly renamed = output<string>();

  // Reads the atom's host element rather than adding a focus API to
  // MuiInputComponent — this molecule owns the "focus + select on activate"
  // behavior, the atom itself stays a plain field.
  @ViewChild(MuiInputComponent, { read: ElementRef })
  private inputHostRef?: ElementRef<HTMLElement>;

  readonly editing = signal(false);
  readonly draft = signal('');
  readonly justCommitted = signal(false);

  startEditing(): void {
    if (this.disabled()) return;
    this.draft.set(this.value());
    this.editing.set(true);
    this.justCommitted.set(false);
    queueMicrotask(() => {
      const control = this.inputHostRef?.nativeElement.querySelector<HTMLInputElement>('.control');
      control?.focus();
      control?.select();
    });
  }

  onDraftChange(next: string): void {
    this.draft.set(next);
  }

  commit(): void {
    if (!this.editing()) return;
    const next = this.draft().trim();
    this.editing.set(false);
    if (next.length === 0 || next === this.value()) return;
    this.value.set(next);
    this.renamed.emit(next);
    this.justCommitted.set(true);
  }

  cancel(): void {
    this.editing.set(false);
  }

  onKeydown(event: KeyboardEvent): void {
    switch (event.key) {
      case 'Enter':
        event.preventDefault();
        this.commit();
        break;
      case 'Escape':
        event.preventDefault();
        this.cancel();
        break;
    }
  }
}
