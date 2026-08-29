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

const SHEET_TRANSITION =
  'transition-[transform_320ms_cubic-bezier(0.32,0.72,0,1),height_320ms_cubic-bezier(0.32,0.72,0,1)]';
import {
  beginSheetDrag,
  isDistanceDismissed,
  isVelocityDismissed,
  shouldIgnoreSheetPointerDown,
  updateSheetDragOffset,
} from '../internal/sheet-drag';

/** Pan-down threshold as a fraction of sheet height, matching
 * BottomSheetComponent's spec-driven constant. */
const DISMISS_FRACTION = 0.25;
/** Pointer velocity threshold for flick-down dismiss (px/s), matching
 * BottomSheetComponent's spec-driven constant. */
const DISMISS_VELOCITY = 1000;
/** Window over which release velocity is measured (ms), matching
 * BottomSheetComponent. */
const VELOCITY_WINDOW_MS = 100;

@Component({
  selector: 'mui-sheet-shell',
  standalone: true,
  templateUrl: './mui-sheet-shell.component.html',
  host: { class: 'contents' },
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

  protected readonly scrimClasses = computed(() =>
    this.contained()
      ? 'mui-sheet-shell-scrim contained absolute inset-0 z-[200] pointer-events-auto bg-[rgba(0,0,0,0.35)]'
      : 'mui-sheet-shell-scrim fixed inset-0 z-[200] pointer-events-auto bg-[rgba(0,0,0,0.35)]',
  );

  /** `contained` and `dragging` each change independent properties
   * (`position` vs `transition`), but both are folded into one computed so
   * every combination stays a single mutually-exclusive lookup rather than
   * base-class-plus-conditional-adds. */
  protected readonly sheetClasses = computed(() => {
    const position = this.contained() ? 'contained absolute' : 'fixed';
    const transition = this.isDragging() ? 'dragging transition-none' : SHEET_TRANSITION;
    return `mui-sheet-shell ${position} left-0 right-0 bottom-0 z-[201] flex flex-col overflow-hidden rounded-t-2xl bg-surface shadow-[0_-8px_30px_rgba(0,0,0,0.6)] outline-none ${transition}`;
  });

  protected readonly heightFraction = computed(() => {
    const detents = this.detents();
    const index = this.activeDetent();
    return detents[index] ?? detents[0] ?? 0.4;
  });

  private readonly sheetEl = viewChild<ElementRef<HTMLElement>>('sheetEl');

  private pointerId: number | null = null;
  private dragStartY = 0;
  private dragStartTimestamp = 0;
  private lastSampleY = 0;
  private lastSampleTimestamp = 0;

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
    this.dragStartTimestamp = event.timeStamp;
    this.lastSampleY = event.clientY;
    this.lastSampleTimestamp = event.timeStamp;
    beginSheetDrag(event, this.isDragging, this.dragOffsetPx);
  }

  protected onPointerMove(event: PointerEvent): void {
    // Pan-down only, matching BottomSheetComponent — upward drag is a no-op.
    if (!updateSheetDragOffset(event, this.pointerId, this.dragStartY, this.dragOffsetPx)) return;
    this.lastSampleY = event.clientY;
    this.lastSampleTimestamp = event.timeStamp;
  }

  protected onPointerUp(event: PointerEvent): void {
    if (this.pointerId !== event.pointerId) return;
    const dy = Math.max(0, event.clientY - this.dragStartY);
    const sheetHeight = this.sheetEl()?.nativeElement.getBoundingClientRect().height ?? 0;
    const distanceTriggered = isDistanceDismissed(dy, sheetHeight, DISMISS_FRACTION);

    // Velocity over the last ~100ms — robust to a slow lead-in followed by a
    // flick. Falls back to the whole drag when it was shorter than that
    // (matches BottomSheetComponent's sampling).
    const totalDt = event.timeStamp - this.dragStartTimestamp;
    const useWholeDrag = totalDt < VELOCITY_WINDOW_MS;
    const sampleDt = useWholeDrag ? totalDt : event.timeStamp - this.lastSampleTimestamp;
    const sampleDy = useWholeDrag ? dy : Math.max(0, event.clientY - this.lastSampleY);
    const velocityTriggered = isVelocityDismissed(sampleDy, sampleDt, DISMISS_VELOCITY);

    this.pointerId = null;
    this.isDragging.set(false);
    this.dragOffsetPx.set(0);

    if (distanceTriggered || velocityTriggered) this.dismissed.emit();
  }

  protected onPointerCancel(event: PointerEvent): void {
    if (this.pointerId !== event.pointerId) return;
    this.pointerId = null;
    this.isDragging.set(false);
    this.dragOffsetPx.set(0);
  }
}
