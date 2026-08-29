// MuiLivingSlider — Maple UI Molecules-L1 (unified-component-catalog.md
// §2.1). Gradient-track slider with a label + numeric readout, built from
// Text + Input. A clean design-system re-implementation of the Pro Editor's
// `LivingSliderComponent` (src/lib/components/develop/living-slider.component.ts)
// — same pointer-capture drag + keyboard-arrow contract, but self-contained
// and tokenized rather than importing that app component.

import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  HostListener,
  OnDestroy,
  ViewChild,
  computed,
  input,
  model,
  output,
  signal,
} from '@angular/core';
import { MuiTextComponent } from '../text/mui-text.component';
import {
  arrowKeyDelta,
  consumeArrowKeyDelta,
  endPointerDrag,
  formatSignedValue,
  isPointerDragEnd,
  percentInRange,
} from '../internal/pointer-drag';

@Component({
  selector: 'mui-living-slider',
  standalone: true,
  imports: [MuiTextComponent],
  templateUrl: './mui-living-slider.component.html',
  host: { class: 'block' },
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class MuiLivingSliderComponent implements OnDestroy {
  readonly label = input.required<string>();
  /** Accessible name override — falls back to the visible label. Lets
   * repeated instances (e.g. one "Lum" slider per grading zone) announce
   * distinctly to screen readers. */
  readonly ariaLabel = input<string | null>(null);
  readonly value = model<number>(0);
  readonly min = input.required<number>();
  readonly max = input.required<number>();
  readonly step = input<number>(1);
  /** CSS `linear-gradient(...)` string painted on the track. */
  readonly gradient = input<string>(
    'linear-gradient(90deg, var(--color-border) 0%, var(--color-primary) 100%)',
  );
  /** True when `min` mirrors `max` around zero — draws a center notch. */
  readonly bipolar = input<boolean>(false);
  readonly unit = input<string>('');
  readonly disabled = input<boolean>(false);

  /**
   * Gesture-boundary outputs (mirrors the Pro Editor's
   * `LivingSliderComponent` / #2411): `dragStart` fires once, before the
   * first per-tick value change of a pointer drag or a held arrow key;
   * `dragEnd` fires once when that gesture ends. A consumer that wants one
   * undo entry per gesture — not one per tick — commits on `dragStart`
   * rather than on every `value` change.
   */
  readonly dragStart = output<void>();
  readonly dragEnd = output<void>();
  /** Fired on double-click instead of self-resetting to zero — not every
   *  tool's default is zero (e.g. Temp = 6500, Sharpen = 40), so only the
   *  consumer knows the right value to restore. */
  readonly resetRequest = output<void>();

  @ViewChild('trackEl') private trackRef!: ElementRef<HTMLElement>;

  readonly dragging = signal(false);
  private activePointerId: number | null = null;
  private pointerDownX = 0;
  private pointerDownValue = 0;
  private trackWidth = 0;
  /** True between a held arrow key's first (non-repeat) keydown and its
   *  keyup/focusout — mirrors `dragging` for the keyboard-gesture case. */
  private keyGestureActive = false;

  // fallow-ignore-next-line unused-class-member -- read from the templateUrl view (`thumbPct()`); fallow's member-usage scan doesn't follow external Angular templates.
  readonly thumbPct = computed(() => percentInRange(this.value(), this.min(), this.max(), 50));

  readonly valueLabel = computed(() => formatSignedValue(this.value(), this.step(), this.unit()));

  onPointerDown(event: PointerEvent): void {
    if (this.disabled() || event.button !== 0 || this.dragging()) return;
    const track = this.trackRef?.nativeElement;
    if (!track) return;

    this.trackWidth = track.getBoundingClientRect().width;
    this.dragging.set(true);
    this.activePointerId = event.pointerId;
    this.pointerDownX = event.clientX;
    this.pointerDownValue = this.value();
    // Gesture boundary before the first per-tick value change (#2411).
    this.dragStart.emit();
    track.setPointerCapture(event.pointerId);
  }

  onPointerMove(event: PointerEvent): void {
    if (!this.dragging() || event.pointerId !== this.activePointerId) return;
    if (this.trackWidth <= 0) return;

    const lo = this.min();
    const hi = this.max();
    const range = hi - lo;
    const dx = event.clientX - this.pointerDownX;
    const delta = (dx / this.trackWidth) * range;
    const raw = this.pointerDownValue + delta;
    const step = this.step();
    const snapped = Math.round(raw / step) * step;
    this.value.set(Math.min(hi, Math.max(lo, snapped)));
  }

  onPointerUp(event: PointerEvent): void {
    const wasDragging = this.dragging() && isPointerDragEnd(event, this.activePointerId);
    endPointerDrag(event, this.activePointerId, this.dragging, () => (this.activePointerId = null));
    if (wasDragging) this.dragEnd.emit();
  }

  private cleanup(): void {
    const wasDragging = this.dragging();
    this.dragging.set(false);
    this.activePointerId = null;
    if (wasDragging) this.dragEnd.emit();
  }

  onKeydown(event: KeyboardEvent): void {
    const delta = consumeArrowKeyDelta(event, this.step());
    if (delta === null) return;
    if (!this.keyGestureActive) {
      this.keyGestureActive = true;
      this.dragStart.emit();
    }
    const lo = this.min();
    const hi = this.max();
    this.value.set(Math.min(hi, Math.max(lo, this.value() + delta)));
  }

  /** Closes the key-hold gesture opened by `onKeydown` (#2411). */
  @HostListener('keyup', ['$event'])
  onKeyup(event: KeyboardEvent): void {
    if (!this.keyGestureActive || arrowKeyDelta(event.key, this.step()) === null) return;
    this.keyGestureActive = false;
    this.dragEnd.emit();
  }

  /** Losing focus mid-hold (tab-away, click elsewhere) must still close the
   *  gesture — the keyup that would normally do it never arrives. */
  @HostListener('focusout')
  onFocusOut(): void {
    if (!this.keyGestureActive) return;
    this.keyGestureActive = false;
    this.dragEnd.emit();
  }

  @HostListener('dblclick')
  onDoubleClick(): void {
    if (this.disabled()) return;
    this.resetRequest.emit();
  }

  ngOnDestroy(): void {
    this.cleanup();
  }
}
