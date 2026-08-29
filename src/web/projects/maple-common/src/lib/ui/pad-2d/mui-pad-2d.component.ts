// MuiPad2d — Maple UI Molecules-L1 ("2-D Pad" in
// unified-component-catalog.md §2.1). Two-axis draggable puck over a
// rectangular gradient field (e.g. white-balance temp/tint); a primitive
// plot with no atom dependency.

import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  ViewChild,
  input,
  model,
  output,
} from '@angular/core';
import { PointerCaptureDragBase } from '../internal/pointer-drag';

export interface MuiPad2dValue {
  /** `[-1, 1]`, right positive. */
  readonly x: number;
  /** `[-1, 1]`, up positive. */
  readonly y: number;
}

const STEP = 0.05;

function clamp(v: number): number {
  return Math.max(-1, Math.min(1, v));
}

@Component({
  selector: 'mui-pad-2d',
  standalone: true,
  templateUrl: './mui-pad-2d.component.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
  // `fill` needs the HOST element itself to stretch to its container's
  // width (the inner `.mui-pad-2d` div's own `width: 100%` has nothing to
  // resolve against otherwise, since the default host is `inline-block` /
  // shrink-to-fit) — a host-bound class rather than touching `:host`
  // unconditionally, so the fixed-`size` default stays exactly as it was
  // for every existing consumer.
  host: { '[class]': 'hostClass()' },
})
export class MuiPad2dComponent extends PointerCaptureDragBase<MuiPad2dValue> {
  readonly value = model<MuiPad2dValue>({ x: 0, y: 0 });
  /** Fixed square side length in px — ignored when `fill` is set. */
  readonly size = input<number>(96);
  /** True sizes the pad to its container's width (`100%`) and holds
   *  `aspectRatio` instead of the fixed `size` square — the WB pad's
   *  responsive, non-square (2:1) box, which a pixel `size` can't express. */
  readonly fill = input<boolean>(false);
  /** Width ÷ height, `fill` mode only. */
  readonly aspectRatio = input<number>(1);
  readonly gradient = input<string>('linear-gradient(135deg, #3b82f6, #f5f2eb 50%, #f59e0b)');
  readonly ariaLabel = input<string>('2-D pad');
  /** Domain-specific aria-valuetext (e.g. "Temp 6500K, Tint +2") — falls
   * back to the raw x/y coordinates. */
  readonly valueText = input<string | null>(null);
  readonly disabled = input<boolean>(false);
  /** Draws two full-width/height guide lines through the puck (e.g. the WB
   *  pad's temperature/tint crosshair) in addition to the puck itself. */
  readonly crosshair = input<boolean>(false);
  /** False lets a consumer with its own value domain (e.g. the WB pad's
   *  Kelvin/tint axes, not this control's normalized `[-1, 1]`) supply
   *  entirely its own arrow-key stepping via `arrowKey` instead of this
   *  control's built-in `±0.05` step — the built-in stepping is skipped, but
   *  the key is still consumed (`preventDefault`/`stopPropagation`) either
   *  way so it never falls through to an ancestor shortcut. */
  readonly stepKeyboard = input<boolean>(true);
  /** Fires for every recognized arrow key, whether or not `stepKeyboard`
   *  applied its own normalized step — the hook a consumer with
   *  `[stepKeyboard]="false"` drives its own domain stepping from. */
  readonly arrowKey = output<KeyboardEvent>();

  @ViewChild('padEl') private padRef!: ElementRef<HTMLElement>;

  /** Host display: `inline-block` (default, fixed `size` square) vs `block
   *  w-full` (`fill` mode, stretches to the container's width). */
  protected hostClass(): string {
    return this.fill() ? 'is-fill block w-full' : 'inline-block';
  }

  /** Puck position as `{left%, top%}` box coordinates (y grows down). */
  // fallow-ignore-next-line unused-class-member -- read from the templateUrl view (`puckPos().left/top`); fallow's member-usage scan doesn't follow external Angular templates.
  puckPos(): { left: number; top: number } {
    const { x, y } = this.value();
    return { left: (x + 1) * 50, top: (1 - y) * 50 };
  }

  protected disabledInput(): boolean {
    return this.disabled();
  }

  protected dragElement(): HTMLElement | undefined {
    return this.padRef?.nativeElement;
  }

  protected valueFromEvent(event: PointerEvent): MuiPad2dValue {
    const rect = this.padRef.nativeElement.getBoundingClientRect();
    const fracX = rect.width > 0 ? (event.clientX - rect.left) / rect.width : 0.5;
    const fracY = rect.height > 0 ? (event.clientY - rect.top) / rect.height : 0.5;
    return { x: clamp(fracX * 2 - 1), y: clamp(1 - fracY * 2) };
  }

  onKeydown(event: KeyboardEvent): void {
    if (this.disabled()) return;
    const current = this.value();
    let next: MuiPad2dValue | null = null;
    switch (event.key) {
      case 'ArrowLeft':
        next = { x: clamp(current.x - STEP), y: current.y };
        break;
      case 'ArrowRight':
        next = { x: clamp(current.x + STEP), y: current.y };
        break;
      case 'ArrowDown':
        next = { x: current.x, y: clamp(current.y - STEP) };
        break;
      case 'ArrowUp':
        next = { x: current.x, y: clamp(current.y + STEP) };
        break;
      default:
        return;
    }
    event.preventDefault();
    event.stopPropagation();
    this.arrowKey.emit(event);
    if (this.stepKeyboard()) this.value.set(next);
  }
}
