// MuiDrawerShell — Maple UI Templates (unified-component-catalog.md §5).
// Two-region layout: Scrim, edge Panel. The design-system generalization of
// `SourcePickerDrawerComponent`'s (../../shells/source-picker-drawer/)
// scrim + pan-to-dismiss shape — same 30%-of-width threshold, `open` as a
// two-way `model()` so the drawer can close itself, and document-level
// Escape. Unlike that phone-only, left-edge-only, chrome-carrying
// component, this is a plain regions-only template: no header/search/tree
// of its own, and `edge` picks either side.
//
// v1 is deliberately gesture-free per the W5 brief ("open/close via model +
// transition") for `open` itself, but the pan-to-dismiss gesture is still
// wired — SourcePickerDrawerComponent's gesture is exactly what a caller
// reaches for the moment they need it, so leaving it out here would just
// mean every consumer re-derives the same pointer math. Motion still comes
// entirely from the CSS transition below (the transform snaps back to 0
// after a drag that doesn't clear the threshold; the actual open/close
// slide is a plain CSS transition on the `left`/`right` inset), matching
// "open/close via model + transition."

import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  HostListener,
  computed,
  input,
  model,
  output,
  signal,
  viewChild,
} from '@angular/core';

export type MuiDrawerShellEdge = 'left' | 'right';

/** Pan-to-dismiss threshold as a fraction of the panel's measured width —
 * same value as SourcePickerDrawerComponent's spec-driven constant. */
const DISMISS_FRACTION = 0.3;

@Component({
  selector: 'mui-drawer-shell',
  standalone: true,
  templateUrl: './mui-drawer-shell.component.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'contents' },
})
export class MuiDrawerShellComponent {
  /** Two-way: caller owns whether the drawer is presented; the drawer can
   * close itself (scrim click, Escape, pan-to-dismiss past threshold). */
  readonly open = model<boolean>(false);
  readonly edge = input<MuiDrawerShellEdge>('left');
  readonly width = input<number>(320);
  /** Positions the scrim/panel absolutely within the nearest positioned
   * ancestor instead of fixed to the viewport (mirrors mui-overlay-shell's
   * `contained` input). */
  readonly contained = input<boolean>(false);

  readonly dismissed = output<void>();

  protected readonly dragDx = signal<number | null>(null);

  /** Scrim positioning: fixed to the viewport, or absolute when `contained`. */
  protected readonly scrimClass = computed(() => (this.contained() ? 'absolute' : 'fixed'));

  /** Panel class list folds three independent axes into one computed so the
   * template never juggles more than one `[class]` binding on the element:
   * position (fixed vs `contained`'s absolute), edge (left vs right, which
   * also flips the drop-shadow direction), and drag state (a live drag
   * disables the CSS transition so the transform tracks the pointer 1:1). */
  protected readonly panelClass = computed(() => {
    const position = this.contained() ? 'absolute' : 'fixed';
    const edgeClasses =
      this.edge() === 'right'
        ? 'left-auto right-0 shadow-[-12px_0_40px_rgba(0,0,0,0.5)]'
        : 'left-0 shadow-[12px_0_40px_rgba(0,0,0,0.5)]';
    const transition =
      this.dragDx() !== null
        ? 'transition-none'
        : 'transition-transform duration-[var(--motion-drawer-ms)] ease-[var(--motion-drawer-ease)]';
    return `${position} ${edgeClasses} ${transition}`;
  });

  private readonly panelEl = viewChild<ElementRef<HTMLElement>>('panelEl');

  private pointerId: number | null = null;
  private pointerStartX = 0;

  @HostListener('document:keydown.escape')
  protected onEscape(): void {
    if (this.open()) this.close();
  }

  protected onScrimClick(): void {
    this.close();
  }

  private close(): void {
    this.open.set(false);
    this.dismissed.emit();
  }

  /** Sign of "closing" motion for the current edge: a left drawer closes on
   * a leftward drag (negative dx); a right drawer closes on a rightward
   * drag (positive dx). */
  private closingSign(): 1 | -1 {
    return this.edge() === 'left' ? -1 : 1;
  }

  protected onPointerDown(event: PointerEvent): void {
    if (this.pointerId !== null) return;
    this.pointerId = event.pointerId;
    this.pointerStartX = event.clientX;
    this.dragDx.set(0);
    (event.currentTarget as HTMLElement).setPointerCapture?.(event.pointerId);
  }

  protected onPointerMove(event: PointerEvent): void {
    if (this.pointerId !== event.pointerId) return;
    const raw = event.clientX - this.pointerStartX;
    // Only track motion in the closing direction — dragging the "wrong" way
    // while at rest is a no-op, same as SourcePickerDrawerComponent.
    const closing = raw * this.closingSign() > 0 ? raw : 0;
    this.dragDx.set(closing);
  }

  protected onPointerUp(event: PointerEvent): void {
    if (this.pointerId !== event.pointerId) return;
    const dx = this.dragDx() ?? 0;
    this.pointerId = null;
    this.dragDx.set(null);
    try {
      (event.currentTarget as HTMLElement).releasePointerCapture?.(event.pointerId);
    } catch {
      /* Pointer may already be released; safe to swallow. */
    }
    const panel = this.panelEl()?.nativeElement;
    const w = panel?.getBoundingClientRect().width ?? this.width();
    if (Math.abs(dx) >= w * DISMISS_FRACTION) this.close();
  }

  protected onPointerCancel(event: PointerEvent): void {
    if (this.pointerId !== event.pointerId) return;
    this.pointerId = null;
    this.dragDx.set(null);
  }
}
