// MuiColorWheel — Maple UI Molecules-L1 (unified-component-catalog.md §2.1).
// Draggable hue/saturation puck; a primitive plot with no atom dependency.
// A clean design-system re-implementation of the Pro Editor's color-grading
// wheel (src/lib/components/develop/color-wheel.component.ts +
// color-wheel-math.ts) — same polar convention (hue 0° = right, increasing
// counter-clockwise; puck radius = saturation) — self-contained and
// tokenized rather than importing that app code.

import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  ViewChild,
  computed,
  input,
  model,
} from '@angular/core';
import { PointerCaptureDragBase } from '../internal/pointer-drag';

export interface MuiColorWheelValue {
  /** Degrees, `[0, 360)`. */
  readonly hue: number;
  /** `[0, 100]`. */
  readonly saturation: number;
}

const HUE_STEP_DEG = 1;
const SAT_STEP = 1;

function wrapHue(deg: number): number {
  const wrapped = deg % 360;
  // `|| 0` normalizes -0 (e.g. from `atan2(-0, 1)` at a pointer exactly on
  // the +x axis) to 0, so a value comparison never sees a sign-only mismatch.
  return (wrapped < 0 ? wrapped + 360 : wrapped) || 0;
}

function clamp01(v: number): number {
  return Math.max(0, Math.min(1, v));
}

@Component({
  selector: 'mui-color-wheel',
  standalone: true,
  templateUrl: './mui-color-wheel.component.html',
  styleUrl: './mui-color-wheel.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class MuiColorWheelComponent extends PointerCaptureDragBase<MuiColorWheelValue> {
  readonly value = model<MuiColorWheelValue>({ hue: 0, saturation: 0 });
  readonly size = input<number>(96);
  readonly ariaLabel = input<string>('Color wheel');
  readonly disabled = input<boolean>(false);

  @ViewChild('wheelEl') private wheelRef!: ElementRef<HTMLElement>;

  /** Puck position as `{left%, top%}` — box coordinates, y grows down. */
  // fallow-ignore-next-line unused-class-member -- read from the templateUrl view (`puckPos().left/top`); fallow's member-usage scan doesn't follow external Angular templates.
  readonly puckPos = computed(() => {
    const { hue, saturation } = this.value();
    const radius = clamp01(saturation / 100);
    const rad = (wrapHue(hue) * Math.PI) / 180;
    const x = radius * Math.cos(rad);
    const y = radius * Math.sin(rad);
    return { left: (x + 1) * 50, top: (1 - y) * 50 };
  });

  protected disabledInput(): boolean {
    return this.disabled();
  }

  protected dragElement(): HTMLElement | undefined {
    return this.wheelRef?.nativeElement;
  }

  protected valueFromEvent(event: PointerEvent): MuiColorWheelValue {
    const wheel = this.wheelRef.nativeElement;
    const rect = wheel.getBoundingClientRect();
    const cx = rect.left + rect.width / 2;
    const cy = rect.top + rect.height / 2;
    const halfSize = rect.width / 2 || 1;
    const dx = (event.clientX - cx) / halfSize;
    const dy = -(event.clientY - cy) / halfSize;
    const radius = Math.min(1, Math.hypot(dx, dy));
    const hue = radius === 0 ? this.value().hue : wrapHue((Math.atan2(dy, dx) * 180) / Math.PI);
    return { hue: Math.round(hue) % 360, saturation: Math.round(radius * 100) };
  }

  onKeydown(event: KeyboardEvent): void {
    const current = this.value();
    let next: MuiColorWheelValue | null = null;
    switch (event.key) {
      case 'ArrowLeft':
        next = { hue: wrapHue(current.hue - HUE_STEP_DEG), saturation: current.saturation };
        break;
      case 'ArrowRight':
        next = { hue: wrapHue(current.hue + HUE_STEP_DEG), saturation: current.saturation };
        break;
      case 'ArrowDown':
        next = { hue: current.hue, saturation: Math.max(0, current.saturation - SAT_STEP) };
        break;
      case 'ArrowUp':
        next = { hue: current.hue, saturation: Math.min(100, current.saturation + SAT_STEP) };
        break;
      default:
        return;
    }
    event.preventDefault();
    event.stopPropagation();
    this.value.set(next);
  }
}
