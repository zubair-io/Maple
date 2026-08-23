// MuiCropOverlay — Maple UI design-system Crop Overlay organism
// (unified-component-catalog.md §4.5). A draggable, keyboard-nudgeable crop
// rectangle over an image: 8 resize handles (4 corners + 4 edge midpoints),
// a rule-of-thirds grid, and a dimmed mask outside the crop.
//
// Deviates from the catalog's "Built from: Drag Bar, Icon" note: Drag Bar's
// 1-D scrub contract (a single value on a track) doesn't fit an 8-handle
// 2-D rectangle resize, so this composes no atoms and implements its own
// pointer-drag/keyboard-nudge math directly — following the same
// "pointerdown hit-test → setPointerCapture → pointermove/pointerup on the
// same element" convention `internal/pointer-drag.ts` documents (mirrored
// from mui-drag-bar's own implementation).

import { ChangeDetectionStrategy, Component, computed, input, model, output } from '@angular/core';
import { isPointerDragEnd, isPointerDragMove } from '../internal/pointer-drag';

export interface MuiCropRect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export type MuiCropHandleId = 'nw' | 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w';

interface MuiCropHandleSpec {
  readonly id: MuiCropHandleId;
  readonly label: string;
  readonly moveLeft: boolean;
  readonly moveTop: boolean;
  readonly moveRight: boolean;
  readonly moveBottom: boolean;
}

const HANDLES: readonly MuiCropHandleSpec[] = [
  {
    id: 'nw',
    label: 'top left',
    moveLeft: true,
    moveTop: true,
    moveRight: false,
    moveBottom: false,
  },
  { id: 'n', label: 'top', moveLeft: false, moveTop: true, moveRight: false, moveBottom: false },
  {
    id: 'ne',
    label: 'top right',
    moveLeft: false,
    moveTop: true,
    moveRight: true,
    moveBottom: false,
  },
  { id: 'e', label: 'right', moveLeft: false, moveTop: false, moveRight: true, moveBottom: false },
  {
    id: 'se',
    label: 'bottom right',
    moveLeft: false,
    moveTop: false,
    moveRight: true,
    moveBottom: true,
  },
  { id: 's', label: 'bottom', moveLeft: false, moveTop: false, moveRight: false, moveBottom: true },
  {
    id: 'sw',
    label: 'bottom left',
    moveLeft: true,
    moveTop: false,
    moveRight: false,
    moveBottom: true,
  },
  { id: 'w', label: 'left', moveLeft: true, moveTop: false, moveRight: false, moveBottom: false },
];

const NUDGE_STEP = 1;
const NUDGE_STEP_SHIFT = 10;

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/** Applies a resize delta for one handle to `startRect`, returning the next
 * rect clamped so it never leaves `[0, containerSize]` on either axis and
 * never shrinks below `minSize` on either axis. Pure — the single source of
 * resize math shared by the pointermove drag handler and the keyboard-nudge
 * handler. Each handle moves a fixed subset of the rect's four edges; the
 * edges it doesn't move act as the anchor the moving edges are clamped
 * against (e.g. dragging `nw` can't push `left` past `right - minSize`). */
export function applyHandleDelta(
  handle: MuiCropHandleId,
  startRect: MuiCropRect,
  dx: number,
  dy: number,
  minSize: number,
  containerSize: { readonly width: number; readonly height: number },
): MuiCropRect {
  const spec = HANDLES.find((h) => h.id === handle);
  if (!spec) return startRect;

  const startLeft = startRect.x;
  const startTop = startRect.y;
  const startRight = startRect.x + startRect.width;
  const startBottom = startRect.y + startRect.height;

  const left = spec.moveLeft ? clamp(startLeft + dx, 0, startRight - minSize) : startLeft;
  const top = spec.moveTop ? clamp(startTop + dy, 0, startBottom - minSize) : startTop;
  const right = spec.moveRight
    ? clamp(startRight + dx, startLeft + minSize, containerSize.width)
    : startRight;
  const bottom = spec.moveBottom
    ? clamp(startBottom + dy, startTop + minSize, containerSize.height)
    : startBottom;

  return { x: left, y: top, width: right - left, height: bottom - top };
}

/** Converts an arrow key into a `{dx, dy}` nudge — the 2-D counterpart of
 * `arrowKeyDelta` (which conflates Left/Down and Right/Up onto a single
 * axis for 1-D scrub controls, the wrong shape for an 8-handle rect where
 * horizontal and vertical must nudge independently). `null` for any other
 * key. */
function nudgeDelta(
  key: string,
  step: number,
): { readonly dx: number; readonly dy: number } | null {
  switch (key) {
    case 'ArrowLeft':
      return { dx: -step, dy: 0 };
    case 'ArrowRight':
      return { dx: step, dy: 0 };
    case 'ArrowUp':
      return { dx: 0, dy: -step };
    case 'ArrowDown':
      return { dx: 0, dy: step };
    default:
      return null;
  }
}

interface MuiCropHandleLayout extends MuiCropHandleSpec {
  readonly left: number;
  readonly top: number;
}

@Component({
  selector: 'mui-crop-overlay',
  standalone: true,
  templateUrl: './mui-crop-overlay.component.html',
  styleUrl: './mui-crop-overlay.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class MuiCropOverlayComponent {
  readonly containerSize = input.required<{ readonly width: number; readonly height: number }>();
  readonly minSize = input<number>(24);
  readonly rect = model<MuiCropRect>({ x: 0, y: 0, width: 100, height: 100 });

  readonly committed = output<MuiCropRect>();

  private activeHandle: MuiCropHandleId | null = null;
  private activePointerId: number | null = null;
  private dragStartRect: MuiCropRect = this.rect();
  private dragStartX = 0;
  private dragStartY = 0;

  readonly rectStyle = computed(() => {
    const r = this.rect();
    return { left: r.x, top: r.y, width: r.width, height: r.height };
  });

  readonly thirdLines = computed(() => {
    const r = this.rect();
    return { v1: r.width / 3, v2: (r.width / 3) * 2, h1: r.height / 3, h2: (r.height / 3) * 2 };
  });

  readonly handleLayout = computed<readonly MuiCropHandleLayout[]>(() => {
    const r = this.rect();
    const midX = r.x + r.width / 2;
    const midY = r.y + r.height / 2;
    const right = r.x + r.width;
    const bottom = r.y + r.height;
    const positions: Record<MuiCropHandleId, { left: number; top: number }> = {
      nw: { left: r.x, top: r.y },
      n: { left: midX, top: r.y },
      ne: { left: right, top: r.y },
      e: { left: right, top: midY },
      se: { left: right, top: bottom },
      s: { left: midX, top: bottom },
      sw: { left: r.x, top: bottom },
      w: { left: r.x, top: midY },
    };
    return HANDLES.map((h) => ({ ...h, left: positions[h.id].left, top: positions[h.id].top }));
  });

  onHandlePointerDown(event: PointerEvent, handle: MuiCropHandleId): void {
    if (event.button !== 0) return;
    const target = event.currentTarget as HTMLElement;
    this.activeHandle = handle;
    this.activePointerId = event.pointerId;
    this.dragStartRect = this.rect();
    this.dragStartX = event.clientX;
    this.dragStartY = event.clientY;
    target.setPointerCapture(event.pointerId);
    event.preventDefault();
  }

  onHandlePointerMove(event: PointerEvent): void {
    if (!isPointerDragMove(this.activeHandle !== null, event, this.activePointerId)) return;
    const dx = event.clientX - this.dragStartX;
    const dy = event.clientY - this.dragStartY;
    this.rect.set(
      applyHandleDelta(
        this.activeHandle!,
        this.dragStartRect,
        dx,
        dy,
        this.minSize(),
        this.containerSize(),
      ),
    );
  }

  onHandlePointerUp(event: PointerEvent): void {
    if (!isPointerDragEnd(event, this.activePointerId)) return;
    this.activeHandle = null;
    this.activePointerId = null;
    this.committed.emit(this.rect());
  }

  onHandleKeydown(event: KeyboardEvent, handle: MuiCropHandleId): void {
    const step = event.shiftKey ? NUDGE_STEP_SHIFT : NUDGE_STEP;
    const delta = nudgeDelta(event.key, step);
    if (delta === null) return;

    event.preventDefault();
    const next = applyHandleDelta(
      handle,
      this.rect(),
      delta.dx,
      delta.dy,
      this.minSize(),
      this.containerSize(),
    );
    this.rect.set(next);
    this.committed.emit(next);
  }
}
