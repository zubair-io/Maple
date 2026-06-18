/// <reference lib="webworker" />

import {
  render_bytes,
  render_bytes_scene_linear,
  render_bytes_scene_linear_sized,
  render_bytes_sized,
  compute_auto_adjustments_from_bytes,
} from './pkg/raw_wasm';
// Namespace import so the gpu-gated `render_bytes_gpu` + `WebLiveSession` (epic
// #925, P4b-web / #1029, #1038) can be accessed DYNAMICALLY: they exist only in
// the `gpu`-feature WASM build, so a named import would break the default (gpu-off)
// bundle's type-check + load. We read them off the module object and existence-check
// before use.
import * as wasm from './pkg/raw_wasm';
import { initRawWasm, type RawWasmInitResult } from './raw-wasm-init';
import type {
  AutoAdjustRequest,
  DecodeRequest,
  DecodeSceneLinearRequest,
  OpenSessionRequest,
  RenderSessionRequest,
  ScopeSnapshot,
  WorkerResponse,
  WorkerRequest,
} from './raw-pipeline.types';

// Forward worker console output to the main thread so Rust panic-hook messages
// (which call console.error inside the worker) are visible in browser DevTools
// and in test harnesses that only read the main-frame console.
{
  const forward =
    (level: 'log' | 'warn' | 'error', orig: (...args: unknown[]) => void) =>
    (...args: unknown[]) => {
      try {
        (self as unknown as Worker).postMessage({
          id: 0,
          type: 'worker-log',
          level,
          text: args
            .map((a) => (a instanceof Error ? (a.stack ?? a.message) : String(a)))
            .join(' '),
        });
      } catch {
        /* ignore — main thread may be gone */
      }
      orig(...args);
    };
  // eslint-disable-next-line no-console
  console.log = forward('log', console.log.bind(console));
  console.warn = forward('warn', console.warn.bind(console));
  console.error = forward('error', console.error.bind(console));
}

let readyPromise: Promise<RawWasmInitResult> | null = null;

function ensureReady(): Promise<RawWasmInitResult> {
  if (!readyPromise) {
    readyPromise = initRawWasm().then((result) => {
      // Let the main thread know whether threading is live so the UI can
      // show a "single-threaded mode" indicator on non-isolated hosts.
      const statusMsg: WorkerResponse = {
        id: 0,
        type: 'status',
        threaded: result.threaded,
        threads: result.threads,
      };
      (self as unknown as Worker).postMessage(statusMsg);
      return result;
    });
  }
  return readyPromise;
}

// Kick off init eagerly so the status message is delivered without waiting
// for the first decode request.
void ensureReady();

addEventListener('message', async (event: MessageEvent<WorkerRequest>) => {
  const req = event.data;
  switch (req.type) {
    case 'decode':
      await handleLegacyDecode(req);
      return;
    case 'decode-scene-linear':
      await handleSceneLinearDecode(req);
      return;
    case 'open-session':
      await handleOpenSession(req);
      return;
    case 'render-session':
      await handleRenderSession(req);
      return;
    case 'close-session':
      handleCloseSession();
      return;
    case 'auto-adjust':
      await handleAutoAdjust(req);
      return;
    default:
      // Unknown request type — silently ignore (matches the prior early-return).
      return;
  }
});

/**
 * The gpu-gated GPU live-render entry (`render_bytes_gpu`, #1029) — present only
 * in the `gpu`-feature WASM build. Typed locally (not imported) because the
 * default bundle doesn't export it; the worker reads it off the module namespace
 * and existence-checks before use. Async (drives WebGPU); returns the SAME
 * `MapleRender` shape `render_bytes` does (u8 RGB), so the response path is
 * unchanged.
 */
type RenderBytesGpuFn = (
  raw: Uint8Array,
  ext: string,
  xmp: string | null,
  // Viewport target in real pixels (#1080): the GPU develop fits the image to
  // this long edge. undefined => the WASM-side 2048 default cap.
  maxLongEdge?: number,
) => Promise<ReturnType<typeof render_bytes>>;

function gpuEntry(): RenderBytesGpuFn | null {
  // `Reflect.get` with a runtime key so the bundler does NOT statically resolve
  // the member (it would emit an "always undefined" warning when built against
  // the default gpu-OFF bundle, which omits `render_bytes_gpu`). Genuinely
  // runtime: the SAME built code works against the GPU bundle (has it) and the
  // default bundle (omits it → falls back to `render_bytes`).
  const fn = Reflect.get(wasm as object, 'render_bytes_gpu');
  return typeof fn === 'function' ? (fn as RenderBytesGpuFn) : null;
}

async function handleLegacyDecode(req: DecodeRequest): Promise<void> {
  try {
    await ensureReady();
    const bytes = new Uint8Array(req.bytes);
    // Sized decode (#1101, spec §5.1): a `maxLongEdge` request routes to the
    // threaded-CPU sized entry — the editor's 2D fast/refine phases, whose
    // `qualityPreview` demosaic profile and per-tick cost the one-shot GPU
    // entry can't honour (it rebuilds the whole GPU context per call). The GPU
    // live path renders through the persistent session (`WebLiveSession`)
    // instead; the one-shot `render_bytes_gpu` stays the W1 parity gate /
    // session fallback for UNSIZED requests, where it self-caps its develop at
    // the WASM-side 2048 default (#1080) — no route develops full sensor res.
    const sized = req.maxLongEdge !== undefined && req.maxLongEdge > 0;
    // Route through the GPU live chain (#1029) only when ALL hold:
    //   1. the request opts in (`req.gpu`, set from `GPU_LIVE_RENDER_ENABLED` —
    //      the operator on/off switch);
    //   2. the runtime advertises WebGPU (`'gpu' in navigator`). The shipped
    //      bundle now co-builds the `gpu` feature (#1059), so `gpuEntry()` is
    //      non-null on EVERY browser — without this check we'd call
    //      `render_bytes_gpu` on a no-WebGPU browser and its `requestAdapter()`
    //      would fail. Gating here keeps the no-WebGPU path byte-for-byte the
    //      threaded-CPU `render_bytes` it is today;
    //   3. the loaded bundle actually exports `render_bytes_gpu` (the `gpu`
    //      feature). Belt-and-braces — false against a hypothetical gpu-off
    //      bundle, true here.
    const gpuFn = !sized && req.gpu && 'gpu' in navigator ? gpuEntry() : null;
    // Worker-local mark so DevTools' Performance panel shows the WASM render
    // call as a distinct entry independent of the main-thread round-trip the
    // service brackets. The mark name distinguishes the GPU/sized paths for
    // profiling (the sized tag carries the cap so a viewport-sized fast phase
    // is visible as evidence in the timeline).
    const markTag = gpuFn
      ? 'maple:wasm-gpu'
      : sized
        ? `maple:wasm-sized:${req.maxLongEdge}`
        : 'maple:wasm';
    performance.mark(`maple:wasm:${req.id}:start`);
    let result;
    if (gpuFn) {
      try {
        // Pass the caller's viewport target (#1080) so the GPU develop is
        // viewport-sized, not full sensor res. Unsized requests (the only ones
        // routed here today) carry undefined => WASM's 2048 default cap.
        result = await gpuFn(bytes, req.ext, req.xmp ?? null, req.maxLongEdge);
      } catch (gpuErr) {
        // Runtime-adapter-failure fallback (#1059): WebGPU was advertised
        // (`'gpu' in navigator`) but the adapter is broken/unavailable —
        // `requestAdapter()` returned null, or device creation/render failed.
        // Without this retry the whole decode would error and the canvas would
        // stay blank on a machine whose GPU path is dead-on-arrival. Re-run the
        // SAME develop on the threaded-CPU `render_bytes` so the image still
        // renders (slower, but correct). The outer catch still handles a genuine
        // CPU decode failure.
        console.warn(
          '[raw-pipeline.worker] GPU render failed; falling back to CPU render_bytes:',
          gpuErr,
        );
        result = render_bytes(bytes, req.ext, req.xmp ?? null);
      }
    } else if (sized) {
      // Viewport-sized CPU render (#1101): post-demosaic stages run at the
      // capped size; `full_width`/`full_height` carry the native dims.
      result = render_bytes_sized(
        bytes,
        req.ext,
        req.xmp ?? null,
        req.qualityPreview ?? false,
        req.maxLongEdge as number,
      );
    } else {
      // Unchanged threaded-CPU path — byte-for-byte today's no-GPU behaviour.
      result = render_bytes(bytes, req.ext, req.xmp ?? null);
    }
    performance.mark(`maple:wasm:${req.id}:end`);
    performance.measure(markTag, `maple:wasm:${req.id}:start`, `maple:wasm:${req.id}:end`);
    // Read the scalars BEFORE taking the buffer, then consume the RGB via
    // `take_rgb()` (#1080): unlike the `rgb` getter (which CLONES the full frame
    // and leaves the wasm copy alive until free/GC), the take MOVES the bytes
    // out, so peak memory is one frame, not two. The explicit `free()` releases
    // the wasm-side struct immediately instead of waiting on GC finalization.
    const width = result.width;
    const height = result.height;
    const nativeWidth = result.full_width;
    const nativeHeight = result.full_height;
    const asShotTemperature = result.as_shot_temperature;
    const asShotTint = result.as_shot_tint;
    const rgb = result.take_rgb();
    result.free();
    const buffer = rgb.buffer.slice(rgb.byteOffset, rgb.byteOffset + rgb.byteLength);
    const response: WorkerResponse = {
      id: req.id,
      type: 'decode-success',
      width,
      height,
      nativeWidth,
      nativeHeight,
      rgb: buffer,
      asShotTemperature,
      asShotTint,
    };
    (self as unknown as Worker).postMessage(response, [buffer]);
  } catch (e) {
    const err = e instanceof Error ? e : null;
    // Surface the full stack so main-thread logs show WASM function indices
    // (useful when a trap hits the panic hook and we need more than the
    // message to find the culprit). `worker-log` forwarding carries this to
    // the page console.
    if (err?.stack) {
      console.error('[raw-pipeline.worker] decode threw:', err.message, err.stack);
    }
    const response: WorkerResponse = {
      id: req.id,
      type: 'decode-error',
      message: err?.message ?? String(e),
    };
    (self as unknown as Worker).postMessage(response);
  }
}

async function handleSceneLinearDecode(req: DecodeSceneLinearRequest): Promise<void> {
  try {
    await ensureReady();
    const bytes = new Uint8Array(req.bytes);
    const sized = req.maxLongEdge !== undefined && req.maxLongEdge > 0;
    // Worker-local mark mirrors the legacy `maple:wasm` perf entry.
    performance.mark(`maple:wasm-scene-linear:${req.id}:start`);
    // Sized routing (#1101, spec §5.1): `render_bytes_scene_linear_sized` is
    // the WASM mirror of the Apple FFI's `maple_render_bytes_scene_linear_sized`
    // (same raw-core path — downsample lands right after demosaic).
    const result = sized
      ? render_bytes_scene_linear_sized(
          bytes,
          req.ext,
          req.xmp ?? null,
          req.qualityPreview,
          req.maxLongEdge as number,
        )
      : render_bytes_scene_linear(bytes, req.ext, req.xmp ?? null, req.qualityPreview);
    performance.mark(`maple:wasm-scene-linear:${req.id}:end`);
    performance.measure(
      sized ? `maple:wasm-scene-linear-sized:${req.maxLongEdge}` : `maple:wasm-scene-linear`,
      `maple:wasm-scene-linear:${req.id}:start`,
      `maple:wasm-scene-linear:${req.id}:end`,
    );
    // Read the scalars BEFORE taking the buffer, then consume the lanes via
    // `take_fp16_rgba()` (#1080): unlike the `fp16_rgba` getter (which CLONES
    // the full frame and leaves the wasm copy alive until free/GC), the take
    // MOVES them out, so peak memory is one frame, not two. wasm-bindgen
    // returns a Uint16Array; slice its underlying buffer so we can transfer it
    // (avoid the main thread holding a copy).
    const width = result.width;
    const height = result.height;
    const nativeWidth = result.full_width;
    const nativeHeight = result.full_height;
    const asShotTemperature = result.as_shot_temperature;
    const asShotTint = result.as_shot_tint;
    const lanes = result.take_fp16_rgba();
    result.free();
    const buffer = lanes.buffer.slice(
      lanes.byteOffset,
      lanes.byteOffset + lanes.byteLength,
    ) as ArrayBuffer;
    const response: WorkerResponse = {
      id: req.id,
      type: 'decode-scene-linear-success',
      width,
      height,
      nativeWidth,
      nativeHeight,
      fp16Rgba: buffer,
      asShotTemperature,
      asShotTint,
    };
    (self as unknown as Worker).postMessage(response, [buffer]);
  } catch (e) {
    const err = e instanceof Error ? e : null;
    if (err?.stack) {
      console.error('[raw-pipeline.worker] decode-scene-linear threw:', err.message, err.stack);
    }
    const response: WorkerResponse = {
      id: req.id,
      type: 'decode-scene-linear-error',
      message: err?.message ?? String(e),
    };
    (self as unknown as Worker).postMessage(response);
  }
}

// ── Persistent GPU live session (epic #925, P4b-web / #1038) ─────────────────
// The worker owns ONE `WebLiveSession` (the GPU-resident state for the focused
// image). `open-session` builds it + presents the first frame; `render-session`
// re-renders for an edit (#846) and presents — both straight to the transferred
// `OffscreenCanvas`, NO CPU readback. The handle is wasm-only (`gpu`-feature build);
// against a gpu-off bundle the open reports an error and the component falls back
// to the 2D `decode()` path.

/**
 * The `WebLiveSession` class from the `gpu`-feature WASM build (#1038). Typed
 * locally (the default bundle omits it); read off the module namespace and
 * existence-checked. `open` is a static async constructor; the instance exposes an
 * async `render(xmp)` and getters for dims + As-Shot WB.
 */
interface WebLiveSessionInstance {
  render(xmp: string | null): Promise<string>;
  /** Developed (viewport-sized per #1080) dims == the canvas dims. */
  readonly width: number;
  readonly height: number;
  /** Native oriented dims — what a full-res render would produce (#1080). */
  readonly fullWidth: number;
  readonly fullHeight: number;
  readonly asShotTemperature: number;
  readonly asShotTint: number;
  readonly colorSpace: string;
  free(): void;
}
interface WebLiveSessionCtor {
  open(
    raw: Uint8Array,
    ext: string,
    xmp: string | null,
    canvas: OffscreenCanvas,
    // Viewport target in real pixels (#1080): the session develop fits the
    // image to this long edge and sizes the canvas to the developed dims.
    // undefined => the WASM-side 2048 default cap.
    maxLongEdge?: number,
  ): Promise<WebLiveSessionInstance>;
}

function liveSessionCtor(): WebLiveSessionCtor | null {
  // `Reflect.get` with a runtime key so the bundler doesn't statically resolve the
  // member (it would warn "always undefined" against the default gpu-OFF bundle,
  // which omits `WebLiveSession`). The SAME built code works against both bundles.
  const ctor = Reflect.get(wasm as object, 'WebLiveSession');
  return typeof ctor === 'function' ? (ctor as unknown as WebLiveSessionCtor) : null;
}

/** The single open session, or null. Only one image is live at a time. */
let liveSession: WebLiveSessionInstance | null = null;

// ── Scope readback (#1045) ───────────────────────────────────────────────────
// The GPU live path presents straight to the transferred `OffscreenCanvas` with NO
// CPU readback, so the histogram/waveform/parade/vectorscope scopes (which read a
// CPU-side `currentPixels` RGBA on the 2D path) had no pixel source and went stale.
// We retain the canvas JS ref here (passing it to wasm `open()` does NOT neuter the
// ref) and, AFTER each present, draw it — downsampled — onto a small 2D canvas and
// read back a tiny RGB snapshot to fold into the session reply. Scopes are
// statistical reductions, so a small downsampled readback of exactly the displayed
// pixels is the apt source (cheaper than a full-res buffer, and reflects what the
// user sees). Wrapped in try/catch: any failure (gpu-off bundle never opens a
// session; a surface that isn't `drawImage`-able; a 2D-context miss) returns null,
// the reply omits the snapshot, and the component leaves `currentPixels` null →
// the scopes render their pseudo fallback, i.e. exactly today's flag-on behaviour.

/** The transferred editor `OffscreenCanvas` for the open session — the readback source. */
let liveCanvas: OffscreenCanvas | null = null;

/** Long-edge cap for the scope readback. Scopes are ~100–250px wide; a 512px long
 *  edge oversamples them comfortably while keeping the readback + transfer trivial. */
const SCOPE_READBACK_MAX_DIM = 512;

/** Reusable downsample target so a slider drag doesn't churn `OffscreenCanvas`es. */
let scopeReadbackCanvas: OffscreenCanvas | null = null;

/**
 * Draw the presented GPU `OffscreenCanvas` onto a small 2D canvas and read back a
 * downsampled, packed-RGB snapshot for the scopes (#1045). Returns null (caller
 * omits the snapshot → scopes keep their pseudo fallback) on any failure, so the
 * GPU path is never WORSE than today even if a browser won't snapshot the surface.
 *
 * `OffscreenCanvas` is undefined-guarded by the open path already; this only runs
 * after a successful present, when `liveCanvas` is set.
 */
function readbackScopeSnapshot(): ScopeSnapshot | null {
  const src = liveCanvas;
  if (!src || typeof OffscreenCanvas === 'undefined') return null;
  try {
    const srcW = src.width;
    const srcH = src.height;
    if (srcW === 0 || srcH === 0) return null;
    const scale = Math.min(1, SCOPE_READBACK_MAX_DIM / Math.max(srcW, srcH));
    const w = Math.max(1, Math.round(srcW * scale));
    const h = Math.max(1, Math.round(srcH * scale));

    if (!scopeReadbackCanvas) {
      scopeReadbackCanvas = new OffscreenCanvas(w, h);
    } else if (scopeReadbackCanvas.width !== w || scopeReadbackCanvas.height !== h) {
      scopeReadbackCanvas.width = w;
      scopeReadbackCanvas.height = h;
    }
    const ctx = scopeReadbackCanvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) return null;
    ctx.clearRect(0, 0, w, h);
    // A webgpu-context canvas is a valid `drawImage` SOURCE (its current presented
    // contents are snapshotted); we can't `getContext('2d')` on it, hence the
    // separate 2D target. The snapshot reflects the last presented frame.
    ctx.drawImage(src as unknown as CanvasImageSource, 0, 0, w, h);
    const { data } = ctx.getImageData(0, 0, w, h);
    // Pack RGBA → RGB to match the `DecodedImage` / `DecodeSuccess.rgb` contract.
    const rgb = new Uint8Array(w * h * 3);
    for (let i = 0, j = 0; i < data.length; i += 4, j += 3) {
      rgb[j] = data[i];
      rgb[j + 1] = data[i + 1];
      rgb[j + 2] = data[i + 2];
    }
    const buffer = rgb.buffer.slice(0, rgb.byteLength) as ArrayBuffer;
    return { width: w, height: h, rgb: buffer };
  } catch (e) {
    // Surface-not-snapshottable / context miss → no snapshot (scopes stay on pseudo).
    console.warn('[raw-pipeline.worker] scope readback failed; scopes use fallback:', e);
    return null;
  }
}

// Re-entrancy gate (the wasm-bindgen `&mut self` borrow hazard): `render` holds the
// session's mutable borrow for its whole Promise (across awaits), so a second
// `render()` entering before the first resolves throws "recursive use of an object
// detected". A full-res develop+chain can exceed the 150ms edit debounce, so
// overlap is reachable on a drag. Serialize: at most one session op runs at a time;
// the next chains after it. (#846's generation counter drops stale RESULTS on the
// main thread — necessary but not sufficient; this prevents the re-entrant CALL.)
let sessionChain: Promise<unknown> = Promise.resolve();
function enqueueSessionOp<T>(op: () => Promise<T>): Promise<T> {
  const next = sessionChain.then(op, op);
  sessionChain = next.catch(() => undefined);
  return next;
}

function postSessionError(id: number, message: string): void {
  const response: WorkerResponse = { id, type: 'session-error', message };
  (self as unknown as Worker).postMessage(response);
}

async function handleOpenSession(req: OpenSessionRequest): Promise<void> {
  await enqueueSessionOp(async () => {
    try {
      await ensureReady();
      // Gate the GPU session on BOTH the bundle exporting `WebLiveSession` AND the
      // runtime advertising WebGPU. The shipped bundle now co-builds the `gpu`
      // feature (#1059), so `liveSessionCtor()` is non-null on EVERY browser —
      // the `'gpu' in navigator` check is what keeps a no-WebGPU browser from
      // attempting (and failing) to open a session. Either miss posts a
      // session-error → the component (`ImageCanvasGpuPresent.open`) falls back to
      // the 2D `decode()` path, which on a no-WebGPU runtime routes threaded-CPU.
      const ctor = 'gpu' in navigator ? liveSessionCtor() : null;
      if (!ctor) {
        postSessionError(
          req.id,
          'gpu' in navigator
            ? 'WebLiveSession unavailable: this WASM bundle was not built with the `gpu` feature'
            : 'WebLiveSession unavailable: this browser does not expose WebGPU (navigator.gpu)',
        );
        return;
      }
      // Tear down any prior session before opening a new one (asset switch).
      liveSession?.free();
      liveSession = null;
      liveCanvas = null;

      const bytes = new Uint8Array(req.bytes);
      performance.mark(`maple:session-open:${req.id}:start`);
      const session = await ctor.open(
        bytes,
        req.ext,
        req.xmp ?? null,
        req.canvas,
        // Viewport target (#1080): the develop + canvas are fit to it, so the
        // session never configures an over-texture-cap (full-sensor-res) surface.
        req.maxLongEdge,
      );
      performance.mark(`maple:session-open:${req.id}:end`);
      performance.measure(
        'maple:session-open',
        `maple:session-open:${req.id}:start`,
        `maple:session-open:${req.id}:end`,
      );
      liveSession = session;
      // Retain the canvas (the readback source) — `open()` did not neuter the JS ref.
      // `open` already presented the first frame, so a snapshot here reflects it.
      liveCanvas = req.canvas;
      const scope = readbackScopeSnapshot();
      const response: WorkerResponse = {
        id: req.id,
        type: 'open-session-success',
        width: session.width,
        height: session.height,
        // Native oriented dims (#1080): the session is viewport-sized, so the
        // editor records THESE on the asset for its fit/100% zoom math (#1101).
        nativeWidth: session.fullWidth,
        nativeHeight: session.fullHeight,
        asShotTemperature: session.asShotTemperature,
        asShotTint: session.asShotTint,
        // The TRUTH the browser configured after the one-time display-p3 retag
        // `open` did (read back via `getConfiguration()`), never an assumption.
        colorSpace: session.colorSpace,
        // Downsampled RGB readback of the first frame for the scopes (#1045);
        // undefined on any readback failure → scopes keep their pseudo fallback.
        scope: scope ?? undefined,
      };
      // Transfer the snapshot buffer when present (small; avoids a main-thread copy).
      (self as unknown as Worker).postMessage(response, scope ? [scope.rgb] : []);
    } catch (e) {
      const err = e instanceof Error ? e : null;
      if (err?.stack) {
        console.error('[raw-pipeline.worker] open-session threw:', err.message, err.stack);
      }
      postSessionError(req.id, err?.message ?? String(e));
    }
  });
}

async function handleRenderSession(req: RenderSessionRequest): Promise<void> {
  await enqueueSessionOp(async () => {
    if (!liveSession) {
      postSessionError(req.id, 'render-session: no open session');
      return;
    }
    try {
      performance.mark(`maple:session-render:${req.id}:start`);
      let colorSpace: string;
      if (req.params) {
        colorSpace = await liveSession.render_with_params(req.params);
      } else {
        colorSpace = await liveSession.render(req.xmp ?? null);
      }
      performance.mark(`maple:session-render:${req.id}:end`);
      performance.measure(
        'maple:session-render',
        `maple:session-render:${req.id}:start`,
        `maple:session-render:${req.id}:end`,
      );
      // Read back the just-presented frame for the scopes (#1045). The render is
      // serialized on `sessionChain`, so the canvas holds this edit's frame here;
      // null on any failure → the scopes keep their previous (or pseudo) data.
      const scope = readbackScopeSnapshot();
      const response: WorkerResponse = {
        id: req.id,
        type: 'render-session-success',
        colorSpace,
        scope: scope ?? undefined,
      };
      (self as unknown as Worker).postMessage(response, scope ? [scope.rgb] : []);
    } catch (e) {
      const err = e instanceof Error ? e : null;
      if (err?.stack) {
        console.error('[raw-pipeline.worker] render-session threw:', err.message, err.stack);
      }
      postSessionError(req.id, err?.message ?? String(e));
    }
  });
}

// ── Auto-adjust one-shot (#1379) ─────────────────────────────────────────────
// Calls the WASM `compute_auto_adjustments_from_bytes` standalone entry —
// independent of any resident GPU live session, so it works on every browser
// including those without WebGPU. The WASM function decodes the RAW internally
// and runs a single AE-Off/D65 probe to derive the 8 slider recommendations.
//
// AE-Off contract: the returned `exposure` was measured against an AE-Off base.
// The Angular caller MUST set `autoExposure: 'Off'` alongside `exposure` (do NOT
// write the returned tone fields in M0 — they are 0 and deferred to #1376).

async function handleAutoAdjust(req: AutoAdjustRequest): Promise<void> {
  try {
    await ensureReady();
    const bytes = new Uint8Array(req.bytes);
    performance.mark(`maple:auto-adjust:${req.id}:start`);
    const result = compute_auto_adjustments_from_bytes(bytes, req.ext, req.xmp ?? undefined);
    performance.mark(`maple:auto-adjust:${req.id}:end`);
    performance.measure(
      'maple:auto-adjust',
      `maple:auto-adjust:${req.id}:start`,
      `maple:auto-adjust:${req.id}:end`,
    );
    // Read all 8 fields before freeing so the struct isn't accessed after drop.
    const patch = {
      exposure: result.exposure,
      temperature: result.temperature,
      tint: result.tint,
      contrast: result.contrast,
      highlights: result.highlights,
      shadows: result.shadows,
      whites: result.whites,
      blacks: result.blacks,
    };
    result.free();
    const response: WorkerResponse = { id: req.id, type: 'auto-adjust-success', patch };
    (self as unknown as Worker).postMessage(response);
  } catch (e) {
    const err = e instanceof Error ? e : null;
    if (err?.stack) {
      console.error('[raw-pipeline.worker] auto-adjust threw:', err.message, err.stack);
    }
    const response: WorkerResponse = {
      id: req.id,
      type: 'auto-adjust-error',
      message: err?.message ?? String(e),
    };
    (self as unknown as Worker).postMessage(response);
  }
}

function handleCloseSession(): void {
  // Enqueue the free so it runs AFTER any in-flight render — `free()` must not run
  // while a render holds the wasm `&mut self` borrow (that throws). The shared queue
  // guarantees the ordering. Fire-and-forget (no reply).
  void enqueueSessionOp(async () => {
    liveSession?.free();
    liveSession = null;
    // Drop the readback source too (its control was transferred to the worker; the
    // element is owned by the now-closed session). A re-open installs a fresh one.
    liveCanvas = null;
  });
}
