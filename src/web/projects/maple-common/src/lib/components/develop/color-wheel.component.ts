// ColorWheelComponent — one round colour-grading wheel (#275).
//
// Angle = hue, radius = saturation. Presentational only: it takes the
// current `(hue, saturation)` through `input()`s and emits every change
// through an `output()`, so the owning panel keeps the single write path
// into the adjustment model. The polar math lives in `color-wheel-math.ts`
// (Angular-free, unit-tested).

import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  OnDestroy,
  computed,
  input,
  output,
  viewChild,
} from '@angular/core';
import { nudgeWheel, posToWheel, wheelToPos, type WheelValue } from './color-wheel-math';

@Component({
  selector: 'pro-color-wheel',
  standalone: true,
  imports: [],
  templateUrl: './color-wheel.component.html',
  styleUrl: './color-wheel.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ColorWheelComponent implements OnDestroy {
  /** Zone name shown under the wheel and used in the accessibility label. */
  readonly label = input.required<string>();
  /** Hue in degrees, `[0, 360)`. */
  readonly hue = input.required<number>();
  /** Saturation in `[0, 100]`. */
  readonly saturation = input.required<number>();

  /** Emitted on every drag tick, arrow-key nudge and double-click reset. */
  readonly wheelChange = output<WheelValue>();

  private readonly wheelEl = viewChild.required<ElementRef<HTMLElement>>('wheelEl');

  readonly puckPos = computed(() => wheelToPos({ hue: this.hue(), saturation: this.saturation() }));

  readonly valueLabel = computed(
    () => `${Math.round(this.hue())}° · ${Math.round(this.saturation())}`,
  );

  readonly ariaLabel = computed(
    () => `${this.label()} colour wheel — drag to set hue and saturation`,
  );

  private moveHandler: ((e: PointerEvent) => void) | null = null;
  private upHandler: (() => void) | null = null;

  ngOnDestroy(): void {
    this.releaseDrag();
  }

  onPointerDown(e: PointerEvent): void {
    if (e.button !== 0) return;
    this.applyPointer(e);
    this.moveHandler = (ev: PointerEvent) => this.applyPointer(ev);
    this.upHandler = () => this.releaseDrag();
    window.addEventListener('pointermove', this.moveHandler);
    window.addEventListener('pointerup', this.upHandler);
    this.wheelEl().nativeElement.setPointerCapture(e.pointerId);
    e.preventDefault();
  }

  onKeyDown(e: KeyboardEvent): void {
    const next = nudgeWheel({ hue: this.hue(), saturation: this.saturation() }, e.key);
    if (!next) return;
    e.preventDefault();
    this.wheelChange.emit(next);
  }

  /** Double-click clears the wheel — saturation 0 is the identity state. */
  onDoubleClick(): void {
    this.wheelChange.emit({ hue: 0, saturation: 0 });
  }

  private applyPointer(e: PointerEvent): void {
    const rect = this.wheelEl().nativeElement.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return;
    const x = (e.clientX - rect.left) / rect.width;
    const y = 1 - (e.clientY - rect.top) / rect.height;
    this.wheelChange.emit(posToWheel({ x, y }));
  }

  private releaseDrag(): void {
    if (this.moveHandler) {
      window.removeEventListener('pointermove', this.moveHandler);
      this.moveHandler = null;
    }
    if (this.upHandler) {
      window.removeEventListener('pointerup', this.upHandler);
      this.upHandler = null;
    }
  }
}
