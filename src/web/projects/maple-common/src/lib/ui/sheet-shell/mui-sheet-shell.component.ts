// MuiSheetShell — Maple UI Templates (unified-component-catalog.md §5).
// Three-region layout: Scrim, Grab handle, Body. The design-system
// generalization of the phone-tier `BottomSheetComponent`
// (../../shells/bottom-sheet.component.ts) — same scrim/grab-handle/
// pan-to-dismiss contract, rebuilt as a regions-only template with a
// `detents` input instead of that component's hardcoded 74vh. Regions
// only — no content of its own.
//
// Detents are fractions (0–1] of the container height; `activeDetent` is a
// `model()` index into that array so a caller can snap the sheet to a
// different detent (e.g. "peek" vs "full") without a drag. Dragging the
// grab handle only ever dismisses (matches BottomSheetComponent's pan-down
// gesture) — it does not cycle detents; that's a deliberately separate
// concern from the dismiss threshold this component owns.
//
// Motion uses the generated `sheet-present`/`sheet-dismiss` tokens
// (../../generated/_ui-tokens.scss) that didn't exist yet when
// BottomSheetComponent shipped (its SCSS has a "swap once S0a lands"
// TODO for exactly these).

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
import {
  beginSheetDrag,
  isDistanceDismissed,
  shouldIgnoreSheetPointerDown,
  updateSheetDragOffset,
} from '../internal/sheet-drag';

/** Pan-down threshold as a fraction of sheet height, matching
 * BottomSheetComponent's spec-driven constant. */
const DISMISS_FRACTION = 0.25;

@Component({
  selector: 'mui-sheet-shell',
  standalone: true,
  templateUrl: './mui-sheet-shell.component.html',
  styleUrl: './mui-sheet-shell.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class MuiSheetShellComponent {
  readonly open = input<boolean>(false);
  /** Fractions (0–1] of container height. Index 0 is the default detent. */
  readonly detents = input<readonly number[]>([0.4, 0.9]);
  readonly activeDetent = model<number>(0);
  /** Positions the scrim/sheet absolutely within the nearest positioned
   * ancestor instead of fixed to the viewport (mirrors mui-overlay-shell's
   * `contained` input). */
  readonly contained = input<boolean>(false);

  readonly dismissed = output<void>();

  protected readonly dragOffsetPx = signal(0);
  protected readonly isDragging = signal(false);

  protected readonly heightFraction = computed(() => {
    const detents = this.detents();
    const index = this.activeDetent();
    return detents[index] ?? detents[0] ?? 0.4;
  });

  private readonly sheetEl = viewChild<ElementRef<HTMLElement>>('sheetEl');

  private pointerId: number | null = null;
  private dragStartY = 0;

  @HostListener('document:keydown.escape')
  protected onEscape(): void {
    if (this.open()) this.dismissed.emit();
  }

  protected onScrimClick(): void {
    this.dismissed.emit();
  }

  protected onPointerDown(event: PointerEvent): void {
    if (shouldIgnoreSheetPointerDown(event)) return;
    this.pointerId = event.pointerId;
    this.dragStartY = event.clientY;
    beginSheetDrag(event, this.isDragging, this.dragOffsetPx);
  }

  protected onPointerMove(event: PointerEvent): void {
    // Pan-down only, matching BottomSheetComponent — upward drag is a no-op.
    updateSheetDragOffset(event, this.pointerId, this.dragStartY, this.dragOffsetPx);
  }

  protected onPointerUp(event: PointerEvent): void {
    if (this.pointerId !== event.pointerId) return;
    const dy = Math.max(0, event.clientY - this.dragStartY);
    const sheetHeight = this.sheetEl()?.nativeElement.getBoundingClientRect().height ?? 0;
    const distanceTriggered = isDistanceDismissed(dy, sheetHeight, DISMISS_FRACTION);

    this.pointerId = null;
    this.isDragging.set(false);
    this.dragOffsetPx.set(0);

    if (distanceTriggered) this.dismissed.emit();
  }

  protected onPointerCancel(event: PointerEvent): void {
    if (this.pointerId !== event.pointerId) return;
    this.pointerId = null;
    this.isDragging.set(false);
    this.dragOffsetPx.set(0);
  }
}
