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
  signal,
} from '@angular/core';
import { isPointerDragEnd, isPointerDragMove } from '../internal/pointer-drag';

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
  styleUrl: './mui-pad-2d.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class MuiPad2dComponent {
  readonly value = model<MuiPad2dValue>({ x: 0, y: 0 });
  readonly size = input<number>(96);
  readonly gradient = input<string>('linear-gradient(135deg, #3b82f6, #f5f2eb 50%, #f59e0b)');
  readonly ariaLabel = input<string>('2-D pad');
  readonly disabled = input<boolean>(false);

  @ViewChild('padEl') private padRef!: ElementRef<HTMLElement>;

  readonly dragging = signal(false);
  private activePointerId: number | null = null;

  /** Puck position as `{left%, top%}` box coordinates (y grows down). */
  // fallow-ignore-next-line unused-class-member -- read from the templateUrl view (`puckPos().left/top`); fallow's member-usage scan doesn't follow external Angular templates.
  puckPos(): { left: number; top: number } {
    const { x, y } = this.value();
    return { left: (x + 1) * 50, top: (1 - y) * 50 };
  }

  private valueFromEvent(event: PointerEvent): MuiPad2dValue {
    const rect = this.padRef.nativeElement.getBoundingClientRect();
    const fracX = rect.width > 0 ? (event.clientX - rect.left) / rect.width : 0.5;
    const fracY = rect.height > 0 ? (event.clientY - rect.top) / rect.height : 0.5;
    return { x: clamp(fracX * 2 - 1), y: clamp(1 - fracY * 2) };
  }

  onPointerDown(event: PointerEvent): void {
    if (this.disabled() || event.button !== 0) return;
    const pad = this.padRef?.nativeElement;
    if (!pad) return;
    this.dragging.set(true);
    this.activePointerId = event.pointerId;
    pad.setPointerCapture(event.pointerId);
    this.value.set(this.valueFromEvent(event));
  }

  onPointerMove(event: PointerEvent): void {
    if (!isPointerDragMove(this.dragging(), event, this.activePointerId)) return;
    this.value.set(this.valueFromEvent(event));
  }

  onPointerUp(event: PointerEvent): void {
    if (!isPointerDragEnd(event, this.activePointerId)) return;
    this.dragging.set(false);
    this.activePointerId = null;
  }

  onKeydown(event: KeyboardEvent): void {
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
    this.value.set(next);
  }
}
