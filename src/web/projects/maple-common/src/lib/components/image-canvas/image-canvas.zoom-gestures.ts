// image-canvas.zoom-gestures.ts — continuous pixelScale zoom math + the
// pointer/wheel/keyboard gesture controller for ImageCanvasComponent
// (#1100, spec §5.0/§5.2; docs/zoom.md is the model). Own file per the
// component file-size budget (same precedent as `image-canvas.gpu-present.ts`).
//
// `pixelScale` semantics (docs/zoom.md): REAL screen pixels per image pixel.
// `0` = fit (auto-computed), `1.0` = true 100% (1 image px = 1 device px —
// dpr-aware, so 100% is pixel-perfect on retina), capped at 8.0. Zoom-out
// during a gesture may go to `fit × 0.5`; releasing below `fit × 1.02`
// snaps back to fit (the Apple `pinchStartScale` + snap contract).
//
// Gesture arbitration (spec §5.0 table):
// - Pinch (two pointers) / trackpad pinch (`wheel`+ctrlKey) / Cmd+wheel →
//   zoom, anchored at the gesture centroid / cursor.
// - One-pointer drag → pan when zoomed; at fit the pan clamp pins the image
//   (S5b's armed-tool drag keeps the gesture at fit).
// - Plain wheel → pan when zoomed; at fit it is left untouched (S5's
//   armed-tool wheel nudge owns it — not `preventDefault`ed here).
// - Double-click → toggle fit ↔ 100%.
// - Cmd/Ctrl+0 → fit, Cmd/Ctrl+1 → 100% (bare 0/1 stay S5 tool/rating keys).

export const MAX_PIXEL_SCALE = 8;
/** Releasing a pinch at or below `fit × SNAP_FACTOR` snaps back to fit. */
export const FIT_SNAP_FACTOR = 1.02;
/** Mid-gesture zoom-out floor: `fit × 0.5` (rubber-band room below fit). */
export const FIT_UNDERSHOOT = 0.5;

/** Fit pixelScale: real px per image px when the image exactly fits the wrap. */
export function fitPixelScale(
  nativeW: number,
  nativeH: number,
  wrapW: number,
  wrapH: number,
  dpr: number,
): number {
  if (nativeW <= 0 || nativeH <= 0 || wrapW <= 0 || wrapH <= 0) return 1;
  return Math.min((wrapW * dpr) / nativeW, (wrapH * dpr) / nativeH);
}

/**
 * Clamp a candidate pixelScale for a SETTLED state (wheel tick, button,
 * gesture end): snaps to fit (`0`) at or below `fit × 1.02`, caps at 8.
 */
export function settlePixelScale(candidate: number, fit: number): number {
  if (candidate <= fit * FIT_SNAP_FACTOR) return 0;
  return Math.min(candidate, MAX_PIXEL_SCALE);
}

/**
 * Clamp a candidate pixelScale DURING a pinch: allows the rubber-band
 * undershoot down to `fit × 0.5`; the snap happens on gesture end.
 */
export function pinchPixelScale(candidate: number, fit: number): number {
  return Math.min(Math.max(candidate, fit * FIT_UNDERSHOOT), MAX_PIXEL_SCALE);
}

/**
 * Pan after zooming anchored at a point, keeping the image point under the
 * anchor stationary. All values in CSS px; `anchor` is relative to the wrap
 * CENTER (the draw centers the image at `wrapCenter + pan`). Derivation:
 * `screen = center + pan + imgVec·s` ⇒ holding `screen` fixed across
 * `s → s'` gives `pan' = anchor − (anchor − pan)·(s'/s)`.
 */
export function panForAnchoredZoom(
  pan: { x: number; y: number },
  anchor: { x: number; y: number },
  cssScaleBefore: number,
  cssScaleAfter: number,
): { x: number; y: number } {
  if (cssScaleBefore <= 0) return pan;
  const r = cssScaleAfter / cssScaleBefore;
  return {
    x: anchor.x - (anchor.x - pan.x) * r,
    y: anchor.y - (anchor.y - pan.y) * r,
  };
}

/**
 * Clamp a pan so the image cannot be flung out of the viewport: each axis
 * allows at most `(imageCss − wrapCss) / 2` of offset (image edges stop at
 * the viewport edges); an axis where the image fits stays centered (0).
 */
export function clampPan(
  pan: { x: number; y: number },
  imgCssW: number,
  imgCssH: number,
  wrapW: number,
  wrapH: number,
): { x: number; y: number } {
  const maxX = Math.max(0, (imgCssW - wrapW) / 2);
  const maxY = Math.max(0, (imgCssH - wrapH) / 2);
  // `+ 0` normalizes the negative zero a `-maxX` clamp of 0 produces.
  return {
    x: Math.min(maxX, Math.max(-maxX, pan.x)) + 0,
    y: Math.min(maxY, Math.max(-maxY, pan.y)) + 0,
  };
}

/** The component surface the gesture controller drives. */
export interface ZoomGestureHost {
  /** Wrap (viewport) size in CSS px. */
  wrapSize(): { w: number; h: number };
  /** Wrap bounding rect (for client→wrap-center coordinates). */
  wrapRect(): DOMRect | null;
  /** Native (full-res, oriented) image dims; null before the cold open. */
  nativeSize(): { w: number; h: number } | null;
  devicePixelRatio(): number;
  /** Current pixelScale (0 = fit). */
  pixelScale(): number;
  /** Commit a settled pixelScale (0 = fit) + pan (CSS px, clamped here). */
  commitView(pixelScale: number, pan: { x: number; y: number }): void;
  pan(): { x: number; y: number };
  /** Before/after divider position update (the drag rides the wrap's pointer stream). */
  moveDivider(clientX: number): void;
}

/** Minimal pointer shape (structurally satisfied by PointerEvent). */
export interface PointerLike {
  pointerId: number;
  clientX: number;
  clientY: number;
  isPrimary?: boolean;
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

/**
 * Pointer-Events pinch/drag + wheel/double-click/keyboard zoom controller.
 * Pinch uses a START-CAPTURED scale (`pinchStartScale`) so the cumulative
 * two-pointer magnification never compounds frame-over-frame.
 */
export class CanvasZoomGestures {
  private readonly pointers = new Map<number, { x: number; y: number }>();
  private pinchStartScale: number | null = null;
  private pinchStartDist = 0;
  private dragLast: { x: number; y: number } | null = null;
  /** True while the before/after divider owns the pointer stream. */
  private dividerDrag = false;

  constructor(private readonly host: ZoomGestureHost) {}

  // ── DOM wiring ─────────────────────────────────────────────────────────

  /**
   * Attach the gesture listeners to the canvas wrap. Imperative (same
   * precedent as `image-canvas.gpu-present.ts`'s DOM work) so the wheel
   * listener is explicitly non-passive (`preventDefault` must work) and the
   * component stays inside its file-size budget. Returns the detach fn.
   */
  attach(el: HTMLElement): () => void {
    const down = (e: PointerEvent) => {
      if (this.dividerDrag) return; // divider owns this pointer
      // Overlay controls (for example the byte-load Retry button) live inside
      // the canvas wrap. Capturing their pointer on the wrap retargets the
      // eventual click away from the control, making it look enabled while
      // doing nothing. Interactive descendants own their pointer stream.
      const target = e.target;
      if (
        target instanceof Element &&
        target.closest('button, a, input, select, textarea, [role="button"], [role="slider"]')
      ) {
        return;
      }
      // Mouse: left or middle button drags (parity with the old mouse path).
      if (e.pointerType === 'mouse' && e.button !== 0 && e.button !== 1) return;
      // Capture on the wrap so drags/pinches survive leaving the element.
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
    const wheel = (e: WheelEvent) => {
      if (this.onWheel(e)) e.preventDefault();
    };
    const dblclick = (e: MouseEvent) => this.onDoubleClick(e.clientX, e.clientY);

    el.addEventListener('pointerdown', down);
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', up);
    el.addEventListener('pointercancel', up);
    el.addEventListener('wheel', wheel, { passive: false });
    el.addEventListener('dblclick', dblclick);
    return () => {
      el.removeEventListener('pointerdown', down);
      el.removeEventListener('pointermove', move);
      el.removeEventListener('pointerup', up);
      el.removeEventListener('pointercancel', up);
      el.removeEventListener('wheel', wheel);
      el.removeEventListener('dblclick', dblclick);
    };
  }

  /** Divider handle pointerdown: the divider owns the stream until release. */
  onDividerDown(e: PointerEvent, wrapEl: HTMLElement): void {
    e.stopPropagation();
    this.dividerDrag = true;
    // Capture on the wrap so the drag keeps tracking (and ends) even when
    // the pointer leaves the element mid-drag.
    capturePointer(wrapEl, e.pointerId);
  }

  /**
   * Cmd/Ctrl+0 → fit, Cmd/Ctrl+1 → 100% (legacy Apple convention; bare
   * `0`/`1` keep their S5 tool/rating meanings — those handlers skip
   * modifier presses). `enabled` gates on a focused asset.
   */
  onKeydown(e: KeyboardEvent, enabled: boolean): void {
    if (!enabled || !(e.metaKey || e.ctrlKey)) return;
    const target = e.target as HTMLElement | null;
    if (target && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) return;
    if (e.key === '0') {
      e.preventDefault();
      this.commit(0, { x: 0, y: 0 });
    } else if (e.key === '1') {
      e.preventDefault();
      this.commit(1, { x: 0, y: 0 });
    }
  }

  // ── Derived state ──────────────────────────────────────────────────────

  /** Effective real pixelScale (fit resolves to the computed fit scale). */
  effectiveScale(): number {
    const ps = this.host.pixelScale();
    if (ps !== 0) return ps;
    return this.fitScale();
  }

  fitScale(): number {
    const native = this.host.nativeSize();
    const { w, h } = this.host.wrapSize();
    if (!native) return 1;
    return fitPixelScale(native.w, native.h, w, h, this.host.devicePixelRatio());
  }

  /** Zoom badge text: percent of the EFFECTIVE real scale, always visible. */
  zoomPercent(): string {
    const ps = this.host.pixelScale();
    if (ps !== 0) return `${Math.round(ps * 100)}%`;
    // At fit the percent derives from viewport/native — readable once the
    // cold open has reported native dims.
    if (!this.host.nativeSize()) return 'Fit';
    return `${Math.round(this.fitScale() * 100)}%`;
  }

  /**
   * Clamped commit: fit recenters; otherwise the pan is clamped so the image
   * edges stop at the viewport (a fitting axis stays centered).
   */
  private commit(ps: number, pan: { x: number; y: number }): void {
    if (ps === 0) {
      this.host.commitView(0, { x: 0, y: 0 });
      return;
    }
    const native = this.host.nativeSize();
    if (!native) {
      this.host.commitView(ps, pan);
      return;
    }
    const css = ps / this.host.devicePixelRatio();
    const { w, h } = this.host.wrapSize();
    this.host.commitView(ps, clampPan(pan, native.w * css, native.h * css, w, h));
  }

  /** Anchor (CSS px, relative to the wrap center) for a client point. */
  private anchorFor(clientX: number, clientY: number): { x: number; y: number } {
    const rect = this.host.wrapRect();
    if (!rect) return { x: 0, y: 0 };
    return {
      x: clientX - rect.left - rect.width / 2,
      y: clientY - rect.top - rect.height / 2,
    };
  }

  /** Apply a zoom to `targetScale` keeping `anchor` stationary, then commit. */
  private zoomAnchored(
    targetScale: number,
    clientX: number,
    clientY: number,
    settle: boolean,
  ): void {
    const fit = this.fitScale();
    const before = this.effectiveScale();
    const next = settle ? settlePixelScale(targetScale, fit) : pinchPixelScale(targetScale, fit);
    const after = next === 0 ? fit : next;
    if (next === 0) {
      // Snapped to fit — recenter (docs/zoom.md: fit resets pan).
      this.commit(0, { x: 0, y: 0 });
      return;
    }
    const dpr = this.host.devicePixelRatio();
    const anchor = this.anchorFor(clientX, clientY);
    const pan = panForAnchoredZoom(this.host.pan(), anchor, before / dpr, after / dpr);
    this.commit(next, pan);
  }

  // ── Pointer events (touch pinch + drag-pan) ────────────────────────────

  onPointerDown(e: PointerLike): void {
    this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (this.pointers.size === 2) {
      // Pinch begins: capture the start scale ONCE (compounding guard).
      const [a, b] = Array.from(this.pointers.values());
      this.pinchStartScale = this.effectiveScale();
      this.pinchStartDist = Math.hypot(a.x - b.x, a.y - b.y) || 1;
      this.dragLast = null; // a second finger cancels the drag-pan
    } else if (this.pointers.size === 1) {
      this.dragLast = { x: e.clientX, y: e.clientY };
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

    if (this.pointers.size === 2 && this.pinchStartScale !== null) {
      const [a, b] = Array.from(this.pointers.values());
      const dist = Math.hypot(a.x - b.x, a.y - b.y) || 1;
      const target = this.pinchStartScale * (dist / this.pinchStartDist);
      const cx = (a.x + b.x) / 2;
      const cy = (a.y + b.y) / 2;
      this.zoomAnchored(target, cx, cy, false);
      return;
    }

    if (this.pointers.size === 1 && this.dragLast) {
      // One-pointer drag: pan. At fit the clamp pins the image to center,
      // so the gesture is inert there (reserved for S5b's tool drag).
      const dx = e.clientX - this.dragLast.x;
      const dy = e.clientY - this.dragLast.y;
      this.dragLast = { x: e.clientX, y: e.clientY };
      const p = this.host.pan();
      this.commit(this.host.pixelScale(), { x: p.x + dx, y: p.y + dy });
    }
  }

  onPointerUp(e: PointerLike): void {
    this.pointers.delete(e.pointerId);
    this.dividerDrag = false;
    if (this.pointers.size < 2 && this.pinchStartScale !== null) {
      // Pinch ended: settle (snap to fit below fit×1.02, else keep).
      this.pinchStartScale = null;
      const ps = this.host.pixelScale();
      const settled = settlePixelScale(ps === 0 ? this.fitScale() : ps, this.fitScale());
      if (settled === 0) this.commit(0, { x: 0, y: 0 });
      else this.commit(settled, this.host.pan());
      // The remaining finger (if any) continues as a drag-pan.
      const rest = Array.from(this.pointers.values());
      this.dragLast = rest.length === 1 ? { x: rest[0].x, y: rest[0].y } : null;
    } else if (this.pointers.size === 0) {
      this.dragLast = null;
    }
  }

  // ── Wheel (trackpad pinch / Cmd+wheel zoom / two-finger pan) ───────────

  /**
   * Route a wheel event per the §5.0 table. Returns `true` when the event
   * was consumed (the caller must `preventDefault`); `false` leaves it for
   * the S5 armed-tool wheel nudge (fit, plain wheel).
   */
  onWheel(e: {
    ctrlKey: boolean;
    metaKey: boolean;
    deltaX: number;
    deltaY: number;
    clientX: number;
    clientY: number;
  }): boolean {
    if (e.ctrlKey || e.metaKey) {
      // Trackpad pinch arrives as ctrlKey+wheel; Cmd/Ctrl+wheel is the
      // explicit zoom chord. Exponential mapping keeps zoom speed
      // resolution-independent; anchored at the cursor.
      const factor = Math.exp(-e.deltaY * 0.01);
      this.zoomAnchored(this.effectiveScale() * factor, e.clientX, e.clientY, true);
      return true;
    }
    if (this.host.pixelScale() !== 0) {
      // Zoomed: plain wheel (two-finger scroll) pans.
      const p = this.host.pan();
      this.commit(this.host.pixelScale(), { x: p.x - e.deltaX, y: p.y - e.deltaY });
      return true;
    }
    // Fit + plain wheel: not ours (S5 armed-tool nudge owns it).
    return false;
  }

  // ── Double-click + buttons + keyboard ──────────────────────────────────

  /** Toggle fit ↔ 100%, anchored at the click point when zooming in. */
  onDoubleClick(clientX: number, clientY: number): void {
    if (this.host.pixelScale() === 0) {
      this.zoomAnchored(1, clientX, clientY, true);
    } else {
      this.commit(0, { x: 0, y: 0 });
    }
  }

  /** Toolbar step zoom (anchored at the viewport center). */
  stepZoom(direction: 1 | -1): void {
    const rect = this.host.wrapRect();
    const cx = rect ? rect.left + rect.width / 2 : 0;
    const cy = rect ? rect.top + rect.height / 2 : 0;
    const factor = direction === 1 ? 1.4 : 1 / 1.4;
    this.zoomAnchored(this.effectiveScale() * factor, cx, cy, true);
  }
}
