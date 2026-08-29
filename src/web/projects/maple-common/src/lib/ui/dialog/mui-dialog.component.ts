// MuiDialog — Maple UI Molecules-L2 (unified-component-catalog.md §3).
// Prompt, confirm, or choice — built from Popover, Text, Input, Button.
// Mirrors mui-popover's dismiss behavior (outside click, Escape, focus onto
// the panel on open) but is modal rather than anchored: a fixed-position
// scrim covers the viewport instead of positioning against a trigger
// element, so it doesn't compose `<mui-popover>` directly.
//
// `busy`/`errorMessage`/destructive focus+role (MW2, #3029): the first two
// real product consumers — the "Delete Permanently" and "Move to Trash"
// confirms that used to extend the legacy `DestructiveConfirmDialogBase` —
// both need to (a) ignore a second Cancel/Confirm click while their request
// is in flight, (b) surface a failed-request message inline, and (c) focus
// Cancel (not the panel) on open and announce as `alertdialog` rather than
// `dialog`, since a destructive confirm is exactly what that ARIA role is
// for. Two real callers needing the same three things is what earns this a
// place on the shared component rather than a per-dialog fork.

import {
  ChangeDetectionStrategy,
  Component,
  computed,
  input,
  model,
  output,
  viewChild,
} from '@angular/core';
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
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'contents' },
})
export class MuiDialogComponent extends OverlayFocusBase {
  readonly title = input.required<string>();
  /** Overrides the panel's `aria-label`, which otherwise mirrors `title`.
   * The two destructive-confirm callers (MW2, #3029) want a static, short
   * visible heading ("Delete Permanently") but a specific accessible name
   * that names the actual target ("Permanently delete photo.dng") — the
   * same distinction the legacy per-dialog markup made between its visible
   * `<span class="…-title">` and its `[attr.aria-label]`. */
  readonly ariaLabel = input<string | null>(null);
  readonly message = input<string | null>(null);
  readonly variant = input<MuiDialogVariant>('confirm');
  readonly confirmLabel = input<string>('Confirm');
  readonly cancelLabel = input<string>('Cancel');
  readonly destructive = input<boolean>(false);
  readonly promptPlaceholder = input<string>('');
  /** Bound value for the `prompt` variant's input field. Unused (and left
   * untouched) for `confirm`. */
  readonly promptValue = model<string>('');
  /** A request is in flight — disables both actions and ignores further
   * Cancel/Confirm activation (click or Enter) until it clears. */
  readonly busy = input<boolean>(false);
  /** Inline failure message shown below `message` (e.g. a rejected delete).
   * `null` renders nothing. */
  readonly errorMessage = input<string | null>(null);

  /** Fires with the current `promptValue` (empty string for `confirm`) when
   * the confirm action is taken. */
  readonly confirmed = output<string>();

  private readonly cancelButton = viewChild<MuiButtonComponent>('cancelBtn');

  readonly role = computed(() => (this.destructive() ? 'alertdialog' : 'dialog'));
  readonly resolvedAriaLabel = computed(() => this.ariaLabel() ?? this.title());

  protected override focusTarget(): { focus(): void } | undefined {
    return this.destructive() ? this.cancelButton() : undefined;
  }

  protected override requestDismiss(): void {
    if (this.busy()) return;
    this.dismissed.emit();
  }

  confirm(): void {
    if (this.busy()) return;
    this.confirmed.emit(this.promptValue());
  }

  cancel(): void {
    this.requestDismiss();
  }
}
