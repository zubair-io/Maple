// Shared "focus-on-open, Escape/scrim dismiss, listener cleanup" skeleton
// behind every full-viewport modal overlay in this library (mui-dialog,
// mui-overlay-shell — unified-component-catalog.md §§3, 5; mui-dialog
// predates mui-overlay-shell, and both need exactly the same open/close
// wiring). Not part of the public API surface (see ../public-api.ts).

import {
  Directive,
  ElementRef,
  type OnDestroy,
  effect,
  input,
  output,
  viewChild,
} from '@angular/core';

/** An `@Directive()` abstract base (Angular's supported pattern for sharing
 * component behavior without a template — same shape as
 * `DestructiveConfirmDialogBase`), not a third free-function copy each
 * subclass re-wires by hand: the effect/listener/cleanup mechanics were
 * already byte-identical between mui-dialog and mui-overlay-shell.
 * `handleNonEscapeKeydown` is the one seam the two need —
 * mui-overlay-shell overrides it to add Tab focus containment; mui-dialog
 * leaves it as the default no-op (Escape-only). Each subclass's own
 * template still declares its own `#panel` div, but both resolve to a
 * plain `HTMLElement`, so the `viewChild` lives here too. */
@Directive()
export abstract class OverlayFocusBase implements OnDestroy {
  readonly open = input<boolean>(false);

  /** Fires on Escape or a scrim click. */
  readonly dismissed = output<void>();

  readonly panel = viewChild<ElementRef<HTMLElement>>('panel');

  constructor() {
    effect(() => {
      if (this.open()) {
        queueMicrotask(() => {
          const target = this.focusTarget();
          if (target) target.focus();
          else this.panel()?.nativeElement.focus();
        });
        document.addEventListener('keydown', this.onKeydown);
      } else {
        document.removeEventListener('keydown', this.onKeydown);
      }
    });
  }

  ngOnDestroy(): void {
    document.removeEventListener('keydown', this.onKeydown);
  }

  private readonly onKeydown = (event: KeyboardEvent): void => {
    if (event.key === 'Escape') {
      this.requestDismiss();
      return;
    }
    this.handleNonEscapeKeydown(event);
  };

  /** No-op by default; mui-overlay-shell overrides this to add Tab focus
   * containment. */
  protected handleNonEscapeKeydown(_event: KeyboardEvent): void {}

  /** Element to focus once the overlay opens, in place of the panel itself.
   * `undefined` (the default) keeps the panel focus. mui-dialog overrides
   * this to focus its Cancel button for a `destructive` confirm — the
   * platform convention (matches the legacy `DestructiveConfirmDialogBase`
   * this replaced, MW2 #3029) of defaulting focus to the safe action so an
   * accidental Enter right after opening can't complete a destructive
   * confirm. */
  protected focusTarget(): { focus(): void } | undefined {
    return undefined;
  }

  /** Emits `dismissed` for Escape and a scrim click alike. mui-dialog
   * overrides this to add its `busy` guard (MW2 #3029) — a request in
   * flight must ignore Escape/scrim-click the same way it ignores a Cancel
   * click, matching the legacy `DestructiveConfirmDialogBase.guardedCancel`
   * behavior it replaced. */
  protected requestDismiss(): void {
    this.dismissed.emit();
  }

  onScrimClick(): void {
    this.requestDismiss();
  }
}
