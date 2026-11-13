// The shared Rust canvas zoom model (raw-core `canvas`, #5714) on the main
// thread. Gestures need an answer inside the same pointer/wheel event, so the
// model cannot ride the render worker's message queue (it is busy for whole
// develops). It ships as its own small unthreaded module (raw-wasm-canvas,
// ~60 KB) rather than a second instance of the pipeline bundle, which is
// ~15 MB and reserves a shared 4 GiB memory.
//
// The boundary carries scalars only: each engine owns a Float64Array laid out
// by `CanvasSlot`, copies it into the module's static scratch block, makes one
// call, and copies the next state back — no allocation on either side.

import { signal } from '@angular/core';
import type * as RawWasm from '../../raw-pipeline/pkg/canvas/raw_wasm_canvas';
import { CANVAS_WASM_GLUE_URL, CANVAS_WASM_URL } from '../../raw-pipeline/wasm-asset-url';

export type CanvasZoomGlue = Pick<
  typeof RawWasm,
  | 'default'
  | 'CanvasSlot'
  | 'CanvasDoubleTap'
  | 'CanvasWheelIntent'
  | 'CanvasZoomStop'
  | 'canvas_scratch_ptr'
  | 'canvas_zoom_pinch_changed'
  | 'canvas_zoom_pinch_ended'
  | 'canvas_zoom_drag_changed'
  | 'canvas_zoom_drag_ended'
  | 'canvas_zoom_wheel_pan'
  | 'canvas_zoom_wheel_zoom'
  | 'canvas_zoom_double_tap'
  | 'canvas_zoom_reset_to_fit'
  | 'canvas_zoom_to_scale'
  | 'canvas_zoom_advance_stop'
  | 'canvas_zoom_step_in'
  | 'canvas_zoom_step_out'
  | 'canvas_zoom_reclamp_pan'
  | 'canvas_zoom_wheel_intent'
  | 'canvas_zoom_effective_scale'
  | 'canvas_zoom_next_badge_stop'
>;

export type CanvasWheelIntent = RawWasm.CanvasWheelIntent;
export type CanvasZoomStop = RawWasm.CanvasZoomStop;
export type CanvasDoubleTap = RawWasm.CanvasDoubleTap;

export interface CanvasZoomModule {
  readonly glue: CanvasZoomGlue;
  readonly memory: WebAssembly.Memory;
}

/** Viewport in CSS px, oriented native image extent (0 × 0 until known), dpr. */
export interface CanvasZoomGeometry {
  readonly viewportWidth: number;
  readonly viewportHeight: number;
  readonly nativeWidth: number;
  readonly nativeHeight: number;
  readonly displayScale: number;
}

const installed = signal<CanvasZoomModule | null>(null);
let pending: Promise<CanvasZoomModule | null> | null = null;

/** The loaded module, or null until `loadCanvasZoomWasm` resolves. Reactive. */
export function canvasZoomModule(): CanvasZoomModule | null {
  return installed();
}

export function installCanvasZoomWasm(
  glue: CanvasZoomGlue,
  memory: WebAssembly.Memory,
): CanvasZoomModule {
  const module = { glue, memory };
  installed.set(module);
  return module;
}

/**
 * Load once per page. A failed load resolves null and is forgotten, so the
 * next canvas to mount (or a later call) retries.
 */
export function loadCanvasZoomWasm(): Promise<CanvasZoomModule | null> {
  pending ??= (async () => {
    const current = installed();
    if (current) return current;
    try {
      const glue = (await import(/* @vite-ignore */ CANVAS_WASM_GLUE_URL)) as CanvasZoomGlue;
      const output = await glue.default({ module_or_path: CANVAS_WASM_URL });
      return installCanvasZoomWasm(glue, output.memory);
    } catch (err) {
      console.warn('[image-canvas] canvas zoom model unavailable:', err);
      pending = null;
      return null;
    }
  })();
  return pending;
}

/** One canvas's zoom state, advanced by the Rust model one transition at a time. */
export class CanvasZoomEngine {
  private readonly slots: Float64Array;
  private scratch: Float64Array;

  constructor(private readonly module: CanvasZoomModule) {
    this.slots = new Float64Array(module.glue.CanvasSlot.Count);
    this.scratch = this.scratchView();
  }

  get pixelScale(): number {
    return this.slots[this.module.glue.CanvasSlot.PixelScale];
  }

  get panX(): number {
    return this.slots[this.module.glue.CanvasSlot.PanX];
  }

  get panY(): number {
    return this.slots[this.module.glue.CanvasSlot.PanY];
  }

  get fillsViewport(): boolean {
    return this.slots[this.module.glue.CanvasSlot.FillsViewport] !== 0;
  }

  /** True while a pinch's start scale, pan and centroid are captured. */
  get pinchCaptured(): boolean {
    return this.slots[this.module.glue.CanvasSlot.HasPinchStartScale] !== 0;
  }

  /** True while a one-pointer drag's translation is recorded in the model. */
  get dragTracked(): boolean {
    const slot = this.module.glue.CanvasSlot;
    return (
      this.slots[slot.HasDragLastTranslation] !== 0 || this.slots[slot.HasDragTranslationBase] !== 0
    );
  }

  get glue(): CanvasZoomGlue {
    return this.module.glue;
  }

  /**
   * Adopt a zoom written outside the model (toolbar Fit / 1:1, a tool arming
   * fit): takes that scale and pan as the resting frame, resolved against the
   * geometry already set, and a live pinch or drag continues from it.
   * Returns whether the state was replaced.
   */
  adopt(pixelScale: number, panX: number, panY: number): boolean {
    const slot = this.module.glue.CanvasSlot;
    if (this.pixelScale === pixelScale && this.panX === panX && this.panY === panY) return false;
    this.slots[slot.PixelScale] = pixelScale;
    this.slots[slot.PanX] = panX;
    this.slots[slot.PanY] = panY;
    this.slots[slot.BasePanX] = panX;
    this.slots[slot.BasePanY] = panY;
    this.slots[slot.FillsViewport] = 0;
    this.reclampPan();
    return true;
  }

  /** Drop the pinch capture so the next pinch frame captures afresh. */
  releasePinchCapture(): void {
    this.slots[this.module.glue.CanvasSlot.HasPinchStartScale] = 0;
  }

  setGeometry(geometry: CanvasZoomGeometry): void {
    const slot = this.module.glue.CanvasSlot;
    this.slots[slot.ViewportWidth] = geometry.viewportWidth;
    this.slots[slot.ViewportHeight] = geometry.viewportHeight;
    this.slots[slot.NativeWidth] = geometry.nativeWidth;
    this.slots[slot.NativeHeight] = geometry.nativeHeight;
    this.slots[slot.DisplayScale] = geometry.displayScale;
  }

  pinchChanged(magnification: number, x: number, y: number): void {
    this.enter();
    this.glue.canvas_zoom_pinch_changed(magnification, x, y);
    this.leave();
  }

  pinchEnded(magnification: number): void {
    this.enter();
    this.glue.canvas_zoom_pinch_ended(magnification);
    this.leave();
  }

  dragChanged(x: number, y: number): boolean {
    this.enter();
    const panned = this.glue.canvas_zoom_drag_changed(x, y);
    this.leave();
    return panned;
  }

  dragEnded(): boolean {
    this.enter();
    const committed = this.glue.canvas_zoom_drag_ended();
    this.leave();
    return committed;
  }

  wheelPan(x: number, y: number): void {
    this.enter();
    this.glue.canvas_zoom_wheel_pan(x, y);
    this.leave();
  }

  wheelZoom(normalizedDeltaY: number, x: number, y: number): void {
    this.enter();
    this.glue.canvas_zoom_wheel_zoom(normalizedDeltaY, x, y);
    this.leave();
  }

  doubleTap(x: number, y: number, behavior: CanvasDoubleTap): void {
    this.enter();
    this.glue.canvas_zoom_double_tap(x, y, behavior);
    this.leave();
  }

  resetToFit(): void {
    this.enter();
    this.glue.canvas_zoom_reset_to_fit();
    this.leave();
  }

  zoomToScale(scale: number): void {
    this.enter();
    this.glue.canvas_zoom_to_scale(scale);
    this.leave();
  }

  advanceStop(): void {
    this.enter();
    this.glue.canvas_zoom_advance_stop();
    this.leave();
  }

  stepIn(): void {
    this.enter();
    this.glue.canvas_zoom_step_in();
    this.leave();
  }

  stepOut(): void {
    this.enter();
    this.glue.canvas_zoom_step_out();
    this.leave();
  }

  reclampPan(): void {
    this.enter();
    this.glue.canvas_zoom_reclamp_pan();
    this.leave();
  }

  wheelIntent(commandHeld: boolean): CanvasWheelIntent {
    this.enter();
    return this.glue.canvas_zoom_wheel_intent(commandHeld);
  }

  effectiveScale(): number {
    this.enter();
    return this.glue.canvas_zoom_effective_scale();
  }

  nextBadgeStop(): CanvasZoomStop {
    this.enter();
    return this.glue.canvas_zoom_next_badge_stop();
  }

  private enter(): void {
    if (this.scratch.buffer !== this.module.memory.buffer) this.scratch = this.scratchView();
    this.scratch.set(this.slots);
  }

  private leave(): void {
    this.slots.set(this.scratch);
  }

  private scratchView(): Float64Array {
    return new Float64Array(
      this.module.memory.buffer,
      this.module.glue.canvas_scratch_ptr(),
      this.slots.length,
    );
  }
}
