// MuiPopover — the Maple UI design-system Popover primitive
// (unified-component-catalog.md §2.4; molecules L1, W3 lane B). The
// anchored-floating-container primitive every overlay menu (Context/
// Suggestion/Command Menu) composes. It has no Built-from row of its own —
// it IS the positioning primitive. The caller wraps both its anchor
// (trigger) element and this component in a `position: relative` box; this
// component absolutely-positions its panel against that box per
// `placement`, dismisses on an outside click or Escape, and moves focus
// onto its own panel on open (focus containment basics — not a full trap).

import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  OnDestroy,
  effect,
  input,
  output,
  viewChild,
} from '@angular/core';

export type MuiPopoverPlacement = 'top' | 'bottom' | 'left' | 'right';

@Component({
  selector: 'mui-popover',
  standalone: true,
  templateUrl: './mui-popover.component.html',
  styleUrl: './mui-popover.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class MuiPopoverComponent implements OnDestroy {
  readonly open = input<boolean>(false);
  readonly placement = input<MuiPopoverPlacement>('bottom');
  /** Fires on an outside click or Escape — the caller owns `open` state and
   * is expected to flip it false in response. */
  readonly closeRequested = output<void>();

  readonly panel = viewChild<ElementRef<HTMLElement>>('panel');

  private readonly onDocumentClick = (event: MouseEvent): void => {
    const panelEl = this.panel()?.nativeElement;
    if (!panelEl) return;
    if (event.target instanceof Node && panelEl.contains(event.target)) return;
    this.closeRequested.emit();
  };

  private readonly onDocumentKeydown = (event: KeyboardEvent): void => {
    if (event.key === 'Escape') this.closeRequested.emit();
  };

  private listenersAttached = false;
  private openTimer: ReturnType<typeof setTimeout> | null = null;

  constructor() {
    effect(() => {
      if (this.open()) {
        // Defer attaching the outside-click listener by one macrotask: the
        // click that flips `open` to true is still bubbling to `document`
        // when this effect first runs (effects fire during change
        // detection, before that same click event finishes propagating in
        // some dispatch orders), so an immediate `addEventListener` here
        // can catch its own opening click and close the panel instantly.
        this.openTimer = setTimeout(() => this.attachListeners(), 0);
        // Focus containment basics: once the panel exists, move focus onto
        // it so keyboard/AT users land inside rather than wherever the
        // trigger click left focus.
        queueMicrotask(() => this.panel()?.nativeElement.focus());
      } else {
        if (this.openTimer !== null) {
          clearTimeout(this.openTimer);
          this.openTimer = null;
        }
        this.detachListeners();
      }
    });
  }

  ngOnDestroy(): void {
    if (this.openTimer !== null) clearTimeout(this.openTimer);
    this.detachListeners();
  }

  private attachListeners(): void {
    if (this.listenersAttached) return;
    document.addEventListener('click', this.onDocumentClick);
    document.addEventListener('keydown', this.onDocumentKeydown);
    this.listenersAttached = true;
  }

  private detachListeners(): void {
    if (!this.listenersAttached) return;
    document.removeEventListener('click', this.onDocumentClick);
    document.removeEventListener('keydown', this.onDocumentKeydown);
    this.listenersAttached = false;
  }
}
