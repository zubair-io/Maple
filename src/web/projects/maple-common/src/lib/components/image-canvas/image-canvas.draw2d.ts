// image-canvas.draw2d.ts — pure canvas geometry + the 2D-canvas paint path for
// ImageCanvasComponent, extracted to keep the component under the file-size
// budget (same precedent as `image-canvas.gpu-present.ts`).
//
// Everything here is a plain function over explicit inputs — no component,
// service, or signal state. The component composes these from its signals:
// `computeEffectivePx` feeds both the 2D draw and the GPU canvas's CSS layout
// (`currentLayout`), `computeViewportTargetLongEdge` is the fast-phase render
// target (#1101), `computeRefineTargetLongEdge` is the refine-phase target
// (docs/zoom.md's `refinedTargetSize` formula), and `drawCanvas2d` paints the
// viewport-sized backing store.

import type { DetailOverlay } from './image-canvas.native-detail';

/** Canvas CSS size + scale for a zoom level (the `effectivePx` derivation). */
export interface EffectivePx {
  scale: number;
  canvasW: number;
  canvasH: number;
}

/**
 * Derive the displayed image size in CSS px for the current zoom: `'fit'`
 * scales the asset into the wrap (never upscaling past 1:1 CSS), a numeric
 * zoom applies directly. Falls back to the reference 6240×4160 asset dims
 * while the real dimensions are unknown (pre-decode).
 */
export function computeEffectivePx(
  zoom: 'fit' | number,
  assetW: number | undefined,
  assetH: number | undefined,
  wrapW: number,
  wrapH: number,
): EffectivePx {
  const aw = assetW ?? 6240;
  const ah = assetH ?? 4160;
  if (zoom === 'fit') {
    const scale = Math.min(wrapW / aw, wrapH / ah, 1);
    return { scale, canvasW: Math.round(aw * scale), canvasH: Math.round(ah * scale) };
  }
  const scale = zoom;
  return { scale, canvasW: Math.round(aw * scale), canvasH: Math.round(ah * scale) };
}

/**
 * The viewport's long edge in REAL (backing-store) pixels — the fast-phase
 * render target (#1101, spec §5.1). Wrap dims are CSS px from the
 * ResizeObserver; multiplying by `devicePixelRatio` yields the backing-store
 * scale, so the rendered buffer is never blurrier than the fitted display.
 * `undefined` when the wrap hasn't been measured (degenerate 0×0) — callers
 * must substitute their own floor rather than rendering full-res.
 *
 * Same name + contract as PR #1096's GPU develop target so the two sized
 * paths (GPU session there, CPU fast/refine here) share one definition.
 */
export function computeViewportTargetLongEdge(wrapW: number, wrapH: number): number | undefined {
  const longEdgeCss = Math.max(wrapW, wrapH);
  if (!Number.isFinite(longEdgeCss) || longEdgeCss <= 0) return undefined;
  const dpr =
    typeof devicePixelRatio === 'number' && Number.isFinite(devicePixelRatio)
      ? Math.max(devicePixelRatio, 1)
      : 1;
  return Math.ceil(longEdgeCss * dpr);
}

/**
 * Real screen pixels per image pixel at the current zoom (docs/zoom.md's
 * `pixelScale` semantics). The stepped zoom levels are CSS scales, so the
 * real scale is `zoom × dpr`; fit derives from the viewport/native ratio.
 */
function effectiveRealPixelScale(
  zoom: 'fit' | number,
  nativeW: number,
  nativeH: number,
  wrapW: number,
  wrapH: number,
  dpr: number,
): number {
  if (zoom !== 'fit') return zoom * dpr;
  return Math.min((wrapW * dpr) / nativeW, (wrapH * dpr) / nativeH);
}

/**
 * Refine-phase target long edge (#1101): `native × min(realScale, 1)`,
 * floored at the fast target and capped at native — `CanvasMath
 * .refinedTargetSize`'s formula (docs/zoom.md). Returns `null` when the
 * refine pass cannot beat the bitmap already painted — at fit the fitted
 * long edge never exceeds the viewport long edge, so refine is skipped
 * there by construction.
 */
export function computeRefineTargetLongEdge(args: {
  zoom: 'fit' | number;
  nativeW: number;
  nativeH: number;
  wrapW: number;
  wrapH: number;
  dpr: number;
  /** Fast-phase target (viewport long edge in real px). */
  fastTarget: number;
  /** Long edge of the bitmap currently painted. */
  paintedLongEdge: number;
}): number | null {
  const nativeLong = Math.max(args.nativeW, args.nativeH);
  const scale = Math.min(
    effectiveRealPixelScale(
      args.zoom,
      args.nativeW,
      args.nativeH,
      args.wrapW,
      args.wrapH,
      args.dpr,
    ),
    1,
  );
  const target = Math.min(nativeLong, Math.ceil(nativeLong * scale));
  const fast = Math.min(args.fastTarget, nativeLong);
  const t = Math.max(target, fast);
  return t > args.paintedLongEdge ? t : null;
}

/** Inputs for `drawCanvas2d`, gathered from the component's signals. */
export interface Draw2dInputs {
  /** Wrap (viewport) size in CSS px — the backing store is this × dpr. */
  wrapW: number;
  wrapH: number;
  /** Displayed image size in CSS px (from `computeEffectivePx`). */
  canvasW: number;
  canvasH: number;
  /** Pan offset in CSS px, applied inside the draw transform. */
  pan: { x: number; y: number };
  /** Decoded pixels; `null` falls back to the gradient placeholder. */
  bitmap: ImageBitmap | null;
  detail?: DetailOverlay | null;
  /** Before/after divider position as a 0..1 fraction; `null` = no split. */
  split: number | null;
  /** Mock-asset gradient thumbnail URL (placeholder path when no bitmap). */
  gradientUrl: string | undefined;
}

/**
 * Gradient placeholder images, cached per URL (PR #1124 review): `drawCanvas2d`
 * runs on every pan/zoom/split tick, and constructing a fresh `Image()` per
 * tick meant repeated decode work plus a pending `onload` closure per frame
 * that could paint out of order when an older load resolved late. The cache
 * makes every draw after the first synchronous; entries live for the session
 * (mock-asset gradients are a handful of tiny data URLs).
 */
interface GradientImageEntry {
  img: HTMLImageElement;
  state: 'loading' | 'ready' | 'failed';
}

const gradientImageCache = new Map<string, GradientImageEntry>();

/**
 * Latest paint generation per canvas. A deferred gradient repaint (scheduled
 * while its image was still loading) only fires if no newer `drawCanvas2d`
 * frame painted the canvas in the meantime — a stale URL's late load can
 * never paint over a newer frame (different gradient or a real bitmap).
 */
const canvasPaintGeneration = new WeakMap<HTMLCanvasElement, number>();

/**
 * Resolve the cached image for `url`, creating + loading it on first sight.
 * Returns the element when ready to draw synchronously; returns `null` while
 * loading (caller paints the procedural fallback and `repaint` runs when the
 * load lands) or after a failed load (procedural fallback, permanently — no
 * per-frame retry, no listener accumulation).
 */
function ensureGradientImage(url: string, repaint: () => void): HTMLImageElement | null {
  let entry = gradientImageCache.get(url);
  if (!entry) {
    const img = new Image();
    const created: GradientImageEntry = { img, state: 'loading' };
    // Assigned before any per-frame 'load' listener attaches, so `state` is
    // already 'ready' when those listeners re-enter `drawCanvas2d`.
    img.onload = () => (created.state = 'ready');
    img.onerror = () => (created.state = 'failed');
    img.src = url;
    entry = created;
    gradientImageCache.set(url, entry);
  }
  if (entry.state === 'ready') return entry.img;
  if (entry.state === 'loading') entry.img.addEventListener('load', repaint, { once: true });
  return null;
}

/**
 * Paint the viewport-sized backing store (#1101): the canvas element fills
 * the wrap and its backing store is `viewport × dpr`; zoom/pan are a draw
 * transform (the destination rect), never the canvas size. The bitmap may be
 * ANY resolution (fast = viewport-sized, refine = up to native) — `drawImage`
 * maps it onto the same destination rect either way. The before/after split
 * clips at a fraction of the VIEWPORT, matching the divider overlay (which is
 * positioned at % of the wrap).
 */
export function drawCanvas2d(canvas: HTMLCanvasElement, inputs: Draw2dInputs): void {
  const { wrapW, wrapH, canvasW, canvasH, pan, bitmap, split, gradientUrl } = inputs;
  const generation = (canvasPaintGeneration.get(canvas) ?? 0) + 1;
  canvasPaintGeneration.set(canvas, generation);
  const dpr = (typeof window !== 'undefined' && window.devicePixelRatio) || 1;
  const bw = Math.max(1, Math.round(wrapW * dpr));
  const bh = Math.max(1, Math.round(wrapH * dpr));
  // Only touch the backing store when the viewport actually changed —
  // assigning width/height clears + reallocates.
  if (canvas.width !== bw) canvas.width = bw;
  if (canvas.height !== bh) canvas.height = bh;

  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  ctx.clearRect(0, 0, bw, bh);
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';

  // Destination rect in real (backing-store) pixels: the displayed image
  // size centered in the viewport, offset by the pan.
  const dw = canvasW * dpr;
  const dh = canvasH * dpr;
  const dx = (wrapW / 2 + pan.x) * dpr - dw / 2;
  const dy = (wrapH / 2 + pan.y) * dpr - dh / 2;

  if (bitmap) {
    drawBitmap(ctx, bitmap, { dx, dy, dw, dh, bw, bh }, split, inputs.detail);
  } else {
    // Gradient placeholder for mock assets — fills the would-be image rect.
    // The first frame for a URL paints the procedural fallback while the
    // image loads, then repaints once the load lands — unless a newer frame
    // painted this canvas in the meantime (generation guard above).
    const gradientImg = gradientUrl
      ? ensureGradientImage(gradientUrl, () => {
          if (canvasPaintGeneration.get(canvas) === generation) drawCanvas2d(canvas, inputs);
        })
      : null;
    if (split !== null) {
      const splitPx = Math.round(bw * split);
      drawClipped(ctx, [0, 0, splitPx, bh], () =>
        drawGradient(ctx, gradientImg, dx, dy, dw, dh, 0),
      );
      drawClipped(ctx, [splitPx, 0, bw - splitPx, bh], () =>
        drawGradient(ctx, gradientImg, dx, dy, dw, dh, 15),
      );
    } else {
      drawGradient(ctx, gradientImg, dx, dy, dw, dh, 0);
    }
  }
}

function drawClipped(
  ctx: CanvasRenderingContext2D,
  clip: [number, number, number, number],
  draw: () => void,
): void {
  ctx.save();
  ctx.beginPath();
  ctx.rect(...clip);
  ctx.clip();
  draw();
  ctx.restore();
}

function drawBitmap(
  ctx: CanvasRenderingContext2D,
  bitmap: ImageBitmap,
  bounds: { dx: number; dy: number; dw: number; dh: number; bw: number; bh: number },
  split: number | null,
  detail: DetailOverlay | null | undefined,
): void {
  const { dx, dy, dw, dh, bw, bh } = bounds;
  if (split !== null) {
    const splitPx = Math.round(bw * split);
    drawClipped(ctx, [0, 0, splitPx, bh], () => ctx.drawImage(bitmap, dx, dy, dw, dh));
    drawClipped(ctx, [splitPx, 0, bw - splitPx, bh], () => {
      ctx.drawImage(bitmap, dx, dy, dw, dh);
      ctx.fillStyle = 'rgba(255,255,255,0.06)';
      ctx.fillRect(splitPx, 0, bw - splitPx, bh);
    });
    return;
  }
  ctx.drawImage(bitmap, dx, dy, dw, dh);
  if (detail)
    ctx.drawImage(
      detail.bitmap,
      dx + (detail.rect.x / detail.nativeW) * dw,
      dy + (detail.rect.y / detail.nativeH) * dh,
      (detail.rect.width / detail.nativeW) * dw,
      (detail.rect.height / detail.nativeH) * dh,
    );
}

/** Paint one gradient-placeholder rect: the cached image when loaded, else
 *  the procedural two-stop fallback. Always synchronous — load waiting lives
 *  in `ensureGradientImage` / the caller's repaint closure. */
function drawGradient(
  ctx: CanvasRenderingContext2D,
  img: HTMLImageElement | null,
  x: number,
  y: number,
  w: number,
  h: number,
  lightenBy: number,
): void {
  if (w <= 0 || h <= 0) return;

  ctx.save();
  ctx.beginPath();
  ctx.rect(x, y, w, h);
  ctx.clip();

  if (img) {
    ctx.drawImage(img, x, y, w, h);
  } else {
    const grd = ctx.createLinearGradient(x, y, x + w, y + h);
    grd.addColorStop(0, '#3a4050');
    grd.addColorStop(1, '#181c22');
    ctx.fillStyle = grd;
    ctx.fillRect(x, y, w, h);
  }

  if (lightenBy > 0) {
    ctx.fillStyle = `rgba(255,255,255,${lightenBy / 100})`;
    ctx.fillRect(x, y, w, h);
  }

  ctx.restore();
}
