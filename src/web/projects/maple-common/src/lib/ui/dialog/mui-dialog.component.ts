// MuiDialog — Maple UI Molecules-L2 (unified-component-catalog.md §3).
// Prompt, confirm, or choice — built from Popover, Text, Input, Button.
// Mirrors mui-popover's dismiss behavior (outside click, Escape, focus onto
// the panel on open) but is modal rather than anchored: a fixed-position
// scrim covers the viewport instead of positioning against a trigger
// element, so it doesn't compose `<mui-popover>` directly.

import { ChangeDetectionStrategy, Component, input, model, output } from '@angular/core';
import { MuiButtonComponent } from '../button/mui-button.component';
import { MuiInputComponent } from '../input/mui-input.component';
import { MuiTextComponent } from '../text/mui-text.component';
import { OverlayFocusBase } from '../internal/overlay-focus';

export type MuiDialogVariant = 'confirm' | 'prompt';

@Component({
  selector: 'mui-dialog',
  standalone: true,
  imports: [MuiButtonComponent, MuiInputComponent, MuiTextComponent],
  templateUrl: './mui-dialog.component.html',
  styleUrl: './mui-dialog.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class MuiDialogComponent extends OverlayFocusBase {
  readonly title = input.required<string>();
  readonly message = input<string | null>(null);
  readonly variant = input<MuiDialogVariant>('confirm');
  readonly confirmLabel = input<string>('Confirm');
  readonly cancelLabel = input<string>('Cancel');
  readonly destructive = input<boolean>(false);
  readonly promptPlaceholder = input<string>('');
  /** Bound value for the `prompt` variant's input field. Unused (and left
   * untouched) for `confirm`. */
  readonly promptValue = model<string>('');

  /** Fires with the current `promptValue` (empty string for `confirm`) when
   * the confirm action is taken. */
  readonly confirmed = output<string>();

  confirm(): void {
    this.confirmed.emit(this.promptValue());
  }

  cancel(): void {
    this.dismissed.emit();
  }
}
