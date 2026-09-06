// image-canvas.two-phase.ts — the fast/refine render scheduler for
// ImageCanvasComponent (#846 → #1101, spec §5.1). Extracted from the component
// to keep it under the file-size budget (same precedent as
// `image-canvas.gpu-present.ts`).
//
// Two phases per spec §5.1 (docs/zoom.md is the contract):
//
//  - FAST phase: on every adjustment tick, immediately render at viewport
//    resolution (element size × devicePixelRatio) through the sized decode
//    (`decode(…, maxLongEdge)` → `render_bytes_sized`, Preview demosaic).
//    Fast renders are coalesced latest-wins: at most one render sits in the
//    worker and at most one tick waits behind it; superseded results are
//    dropped via the host's generation counter (a WASM render can't be
//    interrupted mid-flight, so "cancel" = drop the stale result).
//  - REFINE phase: a 150 ms trailing debounce at
//    `nativeLongEdge × min(realZoomScale, 1)` floored at the fast target
//    (`CanvasMath.refinedTargetSize`'s formula). At fit the refine target
//    equals the fast target by construction, so refine is skipped — fit
//    renders only the viewport-sized image. Zoomed in, refine sharpens up to
//    native. The target is recomputed at fire time so a zoom that settled
//    meanwhile is honoured.
//
// On the GPU live path (#1038) the persistent session renders with resident
// buffers (upload-once; per-tick = uniforms + dispatch), so ticks route
// straight to the session (immediate, coalesced inside `runRender`) and the
// refine pass is skipped (`gpuActive`). This closes the "fast phase
// intentionally deferred" follow-up recorded under #846.

/** Per-render sizing decision (worker `DecodeRequest.maxLongEdge` shape). */
export interface RenderSizing {
  maxLongEdge: number;
  qualityPreview: boolean;
}

/** The component surface the scheduler drives. */
export interface TwoPhaseRenderHost {
  /** Monotonic generation counter — stale renders compare against it. */
  currentGeneration(): number;
  /** Fast-phase target: viewport long edge in real px (never 0). */
  fastTargetPx(): number;
  /**
   * Refine-phase target, or `null` when refine cannot beat the painted
   * bitmap (fit, zoom-out, or already-native).
   */
  refineTargetPx(): number | null;
  /** True while the GPU session presents — the refine pass is skipped. */
  gpuActive(): boolean;
  tryNativeDetail?(xmp: string, generation: number): Promise<boolean>;
  /** Execute one render at the given sizing (the component's `runRender`). */
  runRender(xmp: string, generation: number, sizing: RenderSizing): Promise<void>;
}

export class TwoPhaseRenderScheduler {
  static readonly REFINE_DEBOUNCE_MS = 150;

  private refineTimer: ReturnType<typeof setTimeout> | null = null;
  // Fast-phase coalescing (latest-wins): the newest tick waiting to render,
  // and whether a fast render is currently in flight draining it.
  private pendingFast: { xmp: string; generation: number } | null = null;
  private fastInFlight = false;
  private fastWork: Promise<void> = Promise.resolve();
  private refineInFlight = false;
  private pendingRefine: { xmp: string; generation: number; revision: number } | null = null;
  private refineRevision = 0;

  constructor(private readonly host: TwoPhaseRenderHost) {}

  /**
   * Schedule the two-phase render for an adjustment tick: the fast phase
   * immediately (coalesced latest-wins) and the refine phase behind the
   * trailing debounce.
   */
  schedule(xmp: string, generation: number): void {
    this.enqueueFast(xmp, generation);
    this.scheduleRefine(xmp, generation);
  }

  /**
   * Fast phase: latest-wins coalescing. The newest tick replaces any waiting
   * one; a single drain loop keeps exactly one render in the worker at a time
   * (the service's decode gate serializes further down too).
   */
  private enqueueFast(xmp: string, generation: number): void {
    this.pendingFast = { xmp, generation };
    if (!this.fastInFlight) this.fastWork = this.drainFast();
  }

  private async drainFast(): Promise<void> {
    this.fastInFlight = true;
    try {
      while (this.pendingFast) {
        const { xmp, generation } = this.pendingFast;
        this.pendingFast = null;
        if (generation !== this.host.currentGeneration()) continue; // superseded tick
        await this.host.runRender(xmp, generation, {
          maxLongEdge: this.host.fastTargetPx(),
          qualityPreview: true,
        });
      }
    } finally {
      this.fastInFlight = false;
    }
  }

  /**
   * Refine phase (2D path only — `gpuActive` skips it): trailing-edge
   * debounce; the target is recomputed at fire time and a `null` target
   * (fit, or nothing to gain over the painted bitmap) skips the pass.
   * Also called directly for view-geometry changes (zoom/resize) so a
   * zoomed view sharpens without an edit.
   */
  scheduleRefine(xmp: string, generation: number): void {
    const revision = ++this.refineRevision;
    if (this.refineTimer) clearTimeout(this.refineTimer);
    if (this.host.gpuActive()) {
      this.refineTimer = null;
      return;
    }
    this.refineTimer = setTimeout(() => {
      this.refineTimer = null;
      this.pendingRefine = { xmp, generation, revision };
      if (!this.refineInFlight) void this.drainRefine();
    }, TwoPhaseRenderScheduler.REFINE_DEBOUNCE_MS);
  }

  private async drainRefine(): Promise<void> {
    this.refineInFlight = true;
    try {
      while (this.pendingRefine) {
        const { xmp, generation, revision } = this.pendingRefine;
        this.pendingRefine = null;
        const stale = () =>
          generation !== this.host.currentGeneration() ||
          revision !== this.refineRevision ||
          this.host.gpuActive();
        // The patch needs the exact completed base anchors. A slow fast pass
        // must not turn the 150 ms timer into an unnecessary full-image refine.
        if (this.fastInFlight) await this.fastWork;
        if (stale()) continue;
        // Pan can need a new patch even when the full-image target cannot grow.
        if (this.host.tryNativeDetail && (await this.host.tryNativeDetail(xmp, generation)))
          continue;
        if (stale()) continue;
        const target = this.host.refineTargetPx();
        if (target !== null)
          await this.host.runRender(xmp, generation, {
            maxLongEdge: target,
            qualityPreview: false,
          });
      }
    } finally {
      this.refineInFlight = false;
    }
  }

  /** Cancel the pending refine timer and any waiting fast tick. */
  clear(): void {
    if (this.refineTimer) {
      clearTimeout(this.refineTimer);
      this.refineTimer = null;
    }
    this.pendingFast = null;
    this.pendingRefine = null;
    this.refineRevision++;
  }
}
