// image-canvas.zoom-gestures.ts — pointer/wheel/keyboard gesture recognition
// for ImageCanvasComponent (#1100, spec §5.0/§5.2; docs/zoom.md). Every zoom
// and pan decision is the shared Rust model's (raw-core `canvas`, #5714, via
// `image-canvas.zoom-wasm.ts`); this file only turns DOM events into its
// transitions and commits the result.
//
// `pixelScale` is REAL screen pixels per image pixel: `0` = fit, `1` = 100%
// (dpr-aware), at most 8; pan is CSS px from the centred position.
//
// Gesture arbitration (spec §5.0 table):
// - Two pointers → pinch, anchored at the live centroid; fit / fill detents.
// - One pointer → pan while the image overflows the viewport; otherwise the
//   drag belongs to the editing surface (left untouched here).
// - Trackpad pinch (`wheel`+ctrlKey) / Cmd+wheel → zoom at the cursor.
// - Plain wheel → pan while the image overflows; otherwise not consumed, so
//   the armed-tool wheel nudge keeps it.
// - Double-click → fit ↔ 100%. Badge click → fit → fill → 100%.
// - Cmd/Ctrl+0 → fit, Cmd/Ctrl+1 → 100% (bare 0/1 stay tool/rating keys).

import { computed, signal } from '@angular/core';
import {
  CanvasZoomEngine,
  canvasZoomModule,
  loadCanvasZoomWasm,
  type CanvasZoomGeometry,
  type CanvasZoomStop,
} from './image-canvas.zoom-wasm';

/**
 * Canvas descendants that own their pointer stream: controls (capturing their
 * pointer on the wrap would retarget the click away from them) and anything
 * marked `[data-owns-pointer]`. Neither the canvas nor the editor's scrub
 * starts a gesture on them.
 */
export const CANVAS_POINTER_OWNERS =
  'button, a, input, select, textarea, [role="button"], [role="slider"], [data-owns-pointer]';

/** The component surface the gesture controller drives. */
export interface ZoomGestureHost {
  /** Wrap (viewport) size in CSS px. */
  wrapSize(): { w: number; h: number };
  /** Wrap bounding rect (for client → viewport coordinates). */
  wrapRect(): DOMRect | null;
  /** Native (full-res, oriented) image dims; null before the cold open. */
  nativeSize(): { w: number; h: number } | null;
  devicePixelRatio(): number;
  /** Current pixelScale (0 = fit). */
  pixelScale(): number;
  pan(): { x: number; y: number };
  /** Commit a pixelScale (0 = fit) and pan the model already clamped. */
  commitView(pixelScale: number, pan: { x: number; y: number }): void;
  /** Before/after divider position update (the drag rides the wrap's pointer stream). */
  moveDivider(clientX: number): void;
}

/** Minimal pointer shape (structurally satisfied by PointerEvent). */
export interface PointerLike {
  pointerId: number;
  clientX: number;
  clientY: number;
  isPrimary?: boolean;
  pointerType?: string;
}

/** Minimal wheel shape (structurally satisfied by WheelEvent). */
export interface WheelLike {
  ctrlKey: boolean;
  metaKey: boolean;
  deltaX: number;
  deltaY: number;
  clientX: number;
  clientY: number;
}

/**
 * `setPointerCapture` THROWS (`NotFoundError`) when the browser no longer
 * considers the pointer active — a real race when the contact lifts before
 * the handler runs (and the norm for synthetic test events). A failed
 * capture must degrade to uncaptured tracking, never kill the gesture.
 */
function capturePointer(el: HTMLElement, pointerId: number): void {
  try {
    el.setPointerCapture?.(pointerId);
  } catch {
    // Inactive pointer — continue uncaptured.
  }
}

/** The zoom shortcut a keydown asks for; text fields keep their own keys. */
function zoomShortcut(e: KeyboardEvent): 'fit' | 'actual-size' | null {
  if (!(e.metaKey || e.ctrlKey)) return null;
  const target = e.target as HTMLElement | null;
  if (target && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) return null;
  if (e.key === '0') return 'fit';
  return e.key === '1' ? 'actual-size' : null;
}

interface Point {
  x: number;
  y: number;
}

interface HostView {
  readonly pixelScale: number;
  readonly x: number;
  readonly y: number;
}

const ORIGIN: Point = Object.freeze({ x: 0, y: 0 });

function distance(a: Point, b: Point): number {
  return Math.hypot(a.x - b.x, a.y - b.y) || 1;
}

export class CanvasZoomGestures {
  private readonly pointers = new Map<number, { x: number; y: number; type?: string }>();
  private engineInstance: CanvasZoomEngine | null = null;
  private pinchStartDistance = 0;
  private pinchMagnification = 1;
  /** The two pointer ids the live pinch measures; null outside a pinch. */
  private pinchPair: readonly [number, number] | null = null;
  /**
   * Bumped when the fill flag changes: the one piece of model state the
   * host's pixelScale / pan signals do not carry (the badge's next stop and
   * the editing routing read it).
   */
  private readonly revision = signal(0);
  private readonly editsAtZoom = computed(() => {
    this.revision();
    const engine = this.engine();
    if (!engine) return this.host.pixelScale() === 0;
    return engine.wheelIntent(false) === engine.glue.CanvasWheelIntent.Editing;
  });
  /** Client point the live one-pointer drag measures its translation from. */
  private dragOrigin: { x: number; y: number } | null = null;
  /** The fill flag as of the last commit; a change bumps `revision`. */
  private committedFill = false;
  /** True while the before/after divider owns the pointer stream. */
  private dividerDrag = false;
  /**
   * The host's zoom as of the last adopt or commit. Adopting resolves the
   * written zoom against the geometry, so the model may hold a different
   * frame than the host until its next commit; comparing the model with the
   * host instead would re-adopt on every pointer move and hold a live drag
   * at its baseline.
   */
  private syncedView: HostView | null = null;

  constructor(private readonly host: ZoomGestureHost) {}

  // ── DOM wiring ─────────────────────────────────────────────────────────

  /**
   * Attach the gesture listeners to the canvas wrap. Imperative so the wheel
   * listener is explicitly non-passive (`preventDefault` must work). Returns
   * the detach fn.
   */
  attach(el: HTMLElement): () => void {
    const down = (e: PointerEvent) => {
      if (this.dividerDrag) return;
      // A canvas overlay that took the press (a crop, mask or retouch handle
      // calls preventDefault as it captures) owns that pointer; capturing it
      // here too would steal its moves.
      if (e.defaultPrevented) return;
      // Overlay controls (for example the byte-load Retry button) live inside
      // the canvas wrap and own their pointer stream.
      const target = e.target;
      if (target instanceof Element && target.closest(CANVAS_POINTER_OWNERS)) return;
      if (e.pointerType === 'mouse' && e.button !== 0 && e.button !== 1) return;
      capturePointer(el, e.pointerId);
      this.onPointerDown(e);
    };
    const move = (e: PointerEvent) => this.onPointerMove(e);
    const up = (e: PointerEvent) => {
      try {
        el.releasePointerCapture?.(e.pointerId);
      } catch {
        // Already released / never captured — nothing to undo.
      }
      this.onPointerUp(e);
    };
    // Only the wrap's own capture: an overlay handle losing its capture
    // bubbles here too and says nothing about the wrap's pointers.
    const lost = (e: PointerEvent) => {
      if (e.target === el) this.onLostPointerCapture(e);
    };
    const wheel = (e: WheelEvent) => {
      if (this.onWheel(e)) e.preventDefault();
    };
    const dblclick = (e: MouseEvent) => this.onDoubleClick(e.clientX, e.clientY);

    el.addEventListener('pointerdown', down);
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', up);
    el.addEventListener('pointercancel', up);
    el.addEventListener('lostpointercapture', lost);
    el.addEventListener('wheel', wheel, { passive: false });
    el.addEventListener('dblclick', dblclick);
    return () => {
      el.removeEventListener('pointerdown', down);
      el.removeEventListener('pointermove', move);
      el.removeEventListener('pointerup', up);
      el.removeEventListener('pointercancel', up);
      el.removeEventListener('lostpointercapture', lost);
      el.removeEventListener('wheel', wheel);
      el.removeEventListener('dblclick', dblclick);
    };
  }

  /** Divider handle pointerdown: the divider owns the stream until release. */
  onDividerDown(e: PointerEvent, wrapEl: HTMLElement): void {
    e.stopPropagation();
    this.dividerDrag = true;
    capturePointer(wrapEl, e.pointerId);
  }

  /** Cmd/Ctrl+0 → fit, Cmd/Ctrl+1 → 100%. `enabled` gates on a focused asset. */
  onKeydown(e: KeyboardEvent, enabled: boolean): void {
    const shortcut = enabled ? zoomShortcut(e) : null;
    if (!shortcut) return;
    e.preventDefault();
    const engine = this.engine();
    if (!engine) {
      this.host.commitView(shortcut === 'fit' ? 0 : 1, { x: 0, y: 0 });
      return;
    }
    if (shortcut === 'fit') engine.resetToFit();
    else engine.zoomToScale(1);
    this.commit(engine);
  }

  // ── Derived state ──────────────────────────────────────────────────────

  /**
   * Zoom badge text: percent of the effective real scale. Reads the host's
   * signals (and the module's load state), so a `computed` over it tracks.
   */
  zoomPercent(): string {
    const pixelScale = this.host.pixelScale();
    const native = this.host.nativeSize();
    const engine = this.engine();
    if (pixelScale === 0 && (!native || !engine)) return 'Fit';
    if (!engine) return `${Math.round(pixelScale * 100)}%`;
    return `${Math.round(engine.effectiveScale() * 100)}%`;
  }

  /** The stop a badge click moves to, for its accessible label; null until loaded. */
  nextBadgeStop(): CanvasZoomStop | null {
    this.revision();
    const engine = this.engine();
    return engine ? engine.nextBadgeStop() : null;
  }

  /**
   * True when nothing overflows the viewport (fit or below), so a plain drag
   * or wheel belongs to the editing surface's scrub and tool nudge rather
   * than panning. Before the model loads, only fit counts.
   */
  pointerEditsAtZoom(): boolean {
    return this.editsAtZoom();
  }

  /** Re-resolve against the current viewport/native size (resize, image landing). */
  reclamp(): void {
    const engine = this.engine();
    if (!engine) return;
    engine.reclampPan();
    this.commit(engine);
  }

  // ── Pointer events (touch pinch + drag-pan) ────────────────────────────

  onPointerDown(e: PointerLike): void {
    // A primary press starts a new contact sequence of its kind: a pointer of
    // that kind still tracked lost its release and must not pinch against it.
    if (e.isPrimary) this.dropStalePointers(e.pointerType);
    this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY, type: e.pointerType });
    if (this.pointers.size === 2) {
      const engine = this.engine();
      if (this.dragOrigin && engine) {
        engine.dragEnded();
        this.commit(engine);
      }
      this.dragOrigin = null;
      this.beginPinch(engine, this.firstTwoPointers());
    } else if (this.pointers.size === 1) {
      this.dragOrigin = { x: e.clientX, y: e.clientY };
    }
  }

  onPointerMove(e: PointerLike): void {
    if (this.dividerDrag) {
      this.host.moveDivider(e.clientX);
      return;
    }
    const tracked = this.pointers.get(e.pointerId);
    if (!tracked) return;
    tracked.x = e.clientX;
    tracked.y = e.clientY;
    if (!this.pinchPair && this.editsAtZoom()) {
      this.restartDragAt(tracked);
      return;
    }
    const engine = this.engine();
    if (!engine) return;
    if (this.pinchPair) this.pinchMoved(engine, this.pinchPair);
    else if (this.pointers.size === 1 && this.dragOrigin)
      this.dragMoved(engine, e, this.dragOrigin);
  }

  private pinchMoved(engine: CanvasZoomEngine, pair: readonly [number, number]): void {
    if (!engine.pinchCaptured) this.beginPinch(engine, pair);
    const [a, b] = this.pairPoints(pair);
    this.pinchMagnification = distance(a, b) / this.pinchStartDistance;
    const centroid = this.viewportPoint((a.x + b.x) / 2, (a.y + b.y) / 2);
    engine.pinchChanged(this.pinchMagnification, centroid.x, centroid.y);
    this.commit(engine);
  }

  /**
   * A move the editing surface took is not pan input: a pan that starts
   * later in the same press measures from this point, on a model holding no
   * drag of its own.
   */
  private restartDragAt(point: Point): void {
    if (!this.dragOrigin) return;
    this.dragOrigin = { x: point.x, y: point.y };
    const engine = this.engine();
    if (engine?.dragTracked) engine.dragEnded();
  }

  private dragMoved(
    engine: CanvasZoomEngine,
    pointer: PointerLike,
    origin: { x: number; y: number },
  ): void {
    if (engine.dragChanged(pointer.clientX - origin.x, pointer.clientY - origin.y)) {
      this.commit(engine);
    }
  }

  onPointerUp(e: PointerLike): void {
    this.pointers.delete(e.pointerId);
    this.dividerDrag = false;
    const engine = this.engine();
    if (this.pinchPair?.includes(e.pointerId)) this.pinchPointerLifted(engine);
    else if (this.pointers.size === 0 && this.dragOrigin) {
      this.dragOrigin = null;
      if (engine?.dragEnded()) this.commit(engine);
    }
  }

  /**
   * The wrap lost a pointer's capture without a release reaching it (another
   * element took the capture, or the browser dropped it): the stream ends
   * there, exactly as if the pointer had lifted. The `lostpointercapture`
   * that follows an ordinary release finds the pointer already gone.
   */
  onLostPointerCapture(e: PointerLike): void {
    if (this.pointers.has(e.pointerId) || this.dividerDrag) this.onPointerUp(e);
  }

  private dropStalePointers(pointerType: string | undefined): void {
    for (const [pointerId, at] of [...this.pointers]) {
      if (at.type === pointerType) this.onPointerUp({ pointerId, clientX: at.x, clientY: at.y });
    }
  }

  private pinchPointerLifted(engine: CanvasZoomEngine | null): void {
    if (this.pointers.size >= 2) {
      // A third finger was down: the pinch carries on over the new pair,
      // measured afresh from the zoom it has reached.
      engine?.releasePinchCapture();
      this.beginPinch(engine, this.firstTwoPointers());
      return;
    }
    this.pinchPair = null;
    if (engine) {
      engine.pinchEnded(this.pinchMagnification);
      this.commit(engine);
    }
    // The remaining finger (if any) continues as a fresh drag.
    const [rest] = this.pointers.values();
    this.dragOrigin = rest ? { x: rest.x, y: rest.y } : null;
  }

  // ── Wheel (trackpad pinch / Cmd+wheel zoom / two-finger pan) ───────────

  /**
   * Route a wheel event per the §5.0 table. Returns `true` when consumed
   * (the caller must `preventDefault`); `false` leaves it for the armed-tool
   * wheel nudge. A zoom chord is always consumed so the browser never
   * page-zooms over the canvas, even before the model has loaded.
   */
  onWheel(e: WheelLike): boolean {
    const commandHeld = e.ctrlKey || e.metaKey;
    if (!commandHeld && this.editsAtZoom()) return false;
    // A horizontal swipe with the chord held carries no zoom; zooming by a
    // factor of 1 would still turn fit into an equal free scale.
    if (commandHeld && e.deltaY === 0) return true;
    const engine = this.engine();
    if (!engine) return commandHeld;
    const glue = engine.glue;
    const intent = engine.wheelIntent(commandHeld);
    if (intent === glue.CanvasWheelIntent.Editing) return false;
    if (intent === glue.CanvasWheelIntent.Zoom) {
      const point = this.viewportPoint(e.clientX, e.clientY);
      engine.wheelZoom(-e.deltaY, point.x, point.y);
    } else {
      engine.wheelPan(-e.deltaX, -e.deltaY);
    }
    this.commit(engine);
    return true;
  }

  // ── Double-click, badge and toolbar steps ──────────────────────────────

  /** Toggle fit ↔ 100%, anchored at the click point when zooming in. */
  onDoubleClick(clientX: number, clientY: number): void {
    const engine = this.engine();
    if (!engine) return;
    const point = this.viewportPoint(clientX, clientY);
    engine.doubleTap(point.x, point.y, engine.glue.CanvasDoubleTap.ToggleFitAnd100);
    this.commit(engine);
  }

  /** Badge click: the next stop in fit → fill → 100%. */
  advanceStop(): void {
    const engine = this.engine();
    if (!engine) return;
    engine.advanceStop();
    this.commit(engine);
  }

  /** Toolbar / ⌘= ⌘- step zoom, anchored at the viewport centre. */
  stepZoom(direction: 1 | -1): void {
    const engine = this.engine();
    if (!engine) return;
    if (direction === 1) engine.stepIn();
    else engine.stepOut();
    this.commit(engine);
  }

  // ── Internals ──────────────────────────────────────────────────────────

  /**
   * The engine primed with the current geometry and the host's committed
   * zoom (adopting any zoom written outside the model); null until the
   * shared model has loaded.
   */
  private engine(): CanvasZoomEngine | null {
    const module = canvasZoomModule();
    if (!module) {
      void loadCanvasZoomWasm();
      return null;
    }
    this.engineInstance ??= new CanvasZoomEngine(module);
    const engine = this.engineInstance;
    engine.setGeometry(this.geometry());
    const view = this.hostView();
    const synced = this.syncedView;
    if (
      !synced ||
      synced.pixelScale !== view.pixelScale ||
      synced.x !== view.x ||
      synced.y !== view.y
    ) {
      engine.adopt(view.pixelScale, view.x, view.y);
      this.syncedView = view;
    }
    return engine;
  }

  private hostView(): HostView {
    const pan = this.host.pan();
    return { pixelScale: this.host.pixelScale(), x: pan.x, y: pan.y };
  }

  private geometry(): CanvasZoomGeometry {
    const { w, h } = this.host.wrapSize();
    const native = this.host.nativeSize();
    return {
      viewportWidth: w,
      viewportHeight: h,
      nativeWidth: native?.w ?? 0,
      nativeHeight: native?.h ?? 0,
      displayScale: this.host.devicePixelRatio(),
    };
  }

  /** Start (or restart) a pinch: capture the spread and the start state. */
  private beginPinch(engine: CanvasZoomEngine | null, pair: readonly [number, number]): void {
    const [a, b] = this.pairPoints(pair);
    this.pinchPair = pair;
    this.pinchStartDistance = distance(a, b);
    this.pinchMagnification = 1;
    if (!engine) return;
    const centroid = this.viewportPoint((a.x + b.x) / 2, (a.y + b.y) / 2);
    engine.pinchChanged(1, centroid.x, centroid.y);
  }

  private firstTwoPointers(): readonly [number, number] {
    const [a, b] = this.pointers.keys();
    return [a, b];
  }

  private pairPoints(pair: readonly [number, number]): [Point, Point] {
    return [this.pointers.get(pair[0]) ?? ORIGIN, this.pointers.get(pair[1]) ?? ORIGIN];
  }

  /** Viewport points from the wrap's top-left for a client point. */
  private viewportPoint(clientX: number, clientY: number): { x: number; y: number } {
    const rect = this.host.wrapRect();
    return rect ? { x: clientX - rect.left, y: clientY - rect.top } : { x: clientX, y: clientY };
  }

  private commit(engine: CanvasZoomEngine): void {
    if (engine.fillsViewport !== this.committedFill) {
      this.committedFill = engine.fillsViewport;
      this.revision.update((n) => n + 1);
    }
    const pan = this.host.pan();
    if (
      engine.pixelScale === this.host.pixelScale() &&
      engine.panX === pan.x &&
      engine.panY === pan.y
    ) {
      return;
    }
    this.host.commitView(engine.pixelScale, { x: engine.panX, y: engine.panY });
    this.syncedView = this.hostView();
  }
}
