/// <reference lib="webworker" />

import {
  default_target_long_edge,
  render_bytes,
  render_bytes_with_film,
  render_bytes_scene_linear,
  render_bytes_scene_linear_sized,
  render_bytes_sized,
  compute_auto_adjustments_from_bytes,
} from './pkg/raw_wasm';
// Namespace import so the gpu-gated `render_bytes_gpu` (epic #925, P4b-web /
// #1029) can be accessed DYNAMICALLY: it exists only in the `gpu`-feature WASM
// build, so a named import would break the default (gpu-off) bundle's
// type-check + load. We read it off the module object and existence-check
// before use.
import * as wasm from './pkg/raw_wasm';
import type {
  AutoAdjustRequest,
  DecodeRequest,
  DecodeSceneLinearRequest,
  WorkerResponse,
  WorkerRequest,
} from './raw-pipeline.types';
import { ensureReady } from './raw-pipeline.worker-handlers';
import { selectLegacyDecodeRoute } from './raw-pipeline.decode-route';
import { markStart, markEnd } from './raw-pipeline.perf';
import { handleExport } from './raw-pipeline.export-handler';
import {
  handleOpenSession,
  handleRenderSession,
  handleSetFilmLut,
  handleCloseSession,
} from './raw-pipeline.session-handler';

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

// Kick off init eagerly so the status message is delivered without waiting
// for the first decode request. `ensureReady` (and the `setDeepDenoiseProgress`
// bridge it installs) live in raw-pipeline.worker-handlers.ts — hoisted there
// so raw-pipeline.session-handler.ts can await the same init gate without an
// import cycle back through this file (file-size budget, #2683).
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
    case 'set-film-lut':
      await handleSetFilmLut(req);
      return;
    case 'auto-adjust':
      await handleAutoAdjust(req);
      return;
    case 'export':
      await handleExport(req);
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

type LegacyDecodeResult = ReturnType<typeof render_bytes>; // shared by every legacy-decode entry

/**
 * `gpu` route (#1029, #1080): one-shot GPU develop, viewport-sized via `req.maxLongEdge` (undefined
 * => WASM-side 2048 cap). Falls back to WASM-CPU — via the film-aware sibling when a look is loaded
 * — on a runtime-adapter failure (#1059). `filmLutBytes` is unreachable here today
 * (`selectLegacyDecodeRoute` never returns `'gpu'` alongside a film LUT, #2683 Task 9 round 1).
 */
async function decodeViaGpuRoute(
  gpuFn: RenderBytesGpuFn,
  bytes: Uint8Array,
  req: DecodeRequest,
  filmLutBytes: Uint8Array | null,
): Promise<LegacyDecodeResult> {
  try {
    return await gpuFn(bytes, req.ext, req.xmp ?? null, req.maxLongEdge);
  } catch (gpuErr) {
    console.warn(
      '[raw-pipeline.worker] GPU render failed; falling back to CPU render_bytes:',
      gpuErr,
    );
    // #2661: render the SAME develop the failed GPU call would have produced.
    // `render_bytes_gpu` self-caps an unsized request at the WASM-side default
    // (#1080), so an UNSIZED CPU retry through `render_bytes` was not the same
    // develop at all — it asked for the full sensor, which on a large sensor is
    // a multi-GB develop. Retry through the sized entry at that same default.
    // (The film branch stays unsized: `selectLegacyDecodeRoute` never routes a
    // film-LUT request through `gpu`, so it is unreachable here — and the wasm
    // entry memory-clamps itself regardless.)
    if (filmLutBytes) {
      return render_bytes_with_film(bytes, req.ext, req.xmp ?? null, filmLutBytes);
    }
    return render_bytes_sized(
      bytes,
      req.ext,
      req.xmp ?? null,
      req.qualityPreview ?? false,
      req.maxLongEdge && req.maxLongEdge > 0 ? req.maxLongEdge : default_target_long_edge(),
    );
  }
}

/**
 * `sized` route (#1101, spec §5.1): viewport-sized CPU render for the editor's 2D fast/refine
 * phases — the one-shot GPU entry can't honour `qualityPreview`'s demosaic profile/per-tick cost.
 */
function decodeViaSizedRoute(bytes: Uint8Array, req: DecodeRequest): LegacyDecodeResult {
  return render_bytes_sized(
    bytes,
    req.ext,
    req.xmp ?? null,
    req.qualityPreview ?? false,
    req.maxLongEdge as number,
  );
}

/**
 * `film` route (epic #2683, Task 9): WASM-CPU render with a film-look loaded — the no-WebGPU
 * counterpart of the live session's `set-film-lut` upload, and the UNCONDITIONAL route for every
 * unsized filmLut-bearing request regardless of GPU capability.
 */
function decodeViaFilmRoute(
  bytes: Uint8Array,
  req: DecodeRequest,
  filmLutBytes: Uint8Array,
): LegacyDecodeResult {
  return render_bytes_with_film(bytes, req.ext, req.xmp ?? null, filmLutBytes);
}

/** `cpu` route: byte-for-byte today's no-GPU, no-look behaviour. */
function decodeViaCpuRoute(bytes: Uint8Array, req: DecodeRequest): LegacyDecodeResult {
  return render_bytes(bytes, req.ext, req.xmp ?? null);
}

// Reads scalars before taking the buffer via `take_rgb()` (#1080: MOVES the bytes out instead of
// the `rgb` getter's clone-and-leave-alive-until-GC), then `free()`s the wasm-side struct.
function postLegacyDecodeSuccess(req: DecodeRequest, result: LegacyDecodeResult): void {
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
}

// Surfaces the full stack (useful for a panic-hook trap) — `worker-log` forwarding carries it on.
function postLegacyDecodeError(req: DecodeRequest, e: unknown): void {
  const err = e instanceof Error ? e : null;
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

/** What `handleLegacyDecode` needs to run one request: the chosen route's inputs + perf tag. */
interface LegacyDecodePlan {
  route: ReturnType<typeof selectLegacyDecodeRoute>;
  filmLutBytes: Uint8Array | null;
  gpuFn: RenderBytesGpuFn | null;
  markTag: string;
}

/**
 * `selectLegacyDecodeRoute` (wasm-free, unit-tested in raw-pipeline.decode-route.spec.ts) is the
 * single source of truth for gpu-vs-sized-vs-film-vs-cpu precedence; this layers the worker-local
 * pieces it can't see on top: `filmLut` bytes materialized once, the belt-and-braces
 * `render_bytes_gpu` bundle check, and the DevTools perf-mark tag.
 */
function planLegacyDecode(req: DecodeRequest): LegacyDecodePlan {
  const route = selectLegacyDecodeRoute(req, 'gpu' in navigator);
  const filmLutBytes =
    req.filmLut && req.filmLut.byteLength > 0 ? new Uint8Array(req.filmLut) : null;
  const gpuFn = route === 'gpu' ? gpuEntry() : null;
  const markTag = gpuFn
    ? 'maple:wasm-gpu'
    : route === 'sized'
      ? `maple:wasm-sized:${req.maxLongEdge}`
      : 'maple:wasm';
  return { route, filmLutBytes, gpuFn, markTag };
}

/** Dispatches to the route's decode function per `plan` (see `planLegacyDecode`). */
async function decodeViaPlan(
  plan: LegacyDecodePlan,
  bytes: Uint8Array,
  req: DecodeRequest,
): Promise<LegacyDecodeResult> {
  if (plan.gpuFn) return decodeViaGpuRoute(plan.gpuFn, bytes, req, plan.filmLutBytes);
  if (plan.route === 'sized') return decodeViaSizedRoute(bytes, req);
  if (plan.filmLutBytes) return decodeViaFilmRoute(bytes, req, plan.filmLutBytes);
  return decodeViaCpuRoute(bytes, req);
}

async function handleLegacyDecode(req: DecodeRequest): Promise<void> {
  try {
    await ensureReady();
    const bytes = new Uint8Array(req.bytes);
    const plan = planLegacyDecode(req);
    // #1123: markStart/markEnd — a throw here must never fall through to the
    // outer `catch` and mislabel a successful decode as a `decode-error`.
    const wasmStartMark = `maple:wasm:${req.id}:start`;
    markStart(wasmStartMark);
    const result = await decodeViaPlan(plan, bytes, req);
    markEnd(wasmStartMark, `maple:wasm:${req.id}:end`, plan.markTag);
    postLegacyDecodeSuccess(req, result);
  } catch (e) {
    postLegacyDecodeError(req, e);
  }
}

async function handleSceneLinearDecode(req: DecodeSceneLinearRequest): Promise<void> {
  try {
    await ensureReady();
    const bytes = new Uint8Array(req.bytes);
    const sized = req.maxLongEdge !== undefined && req.maxLongEdge > 0;
    // Worker-local mark mirrors the legacy `maple:wasm` perf entry.
    // #1123: markStart/markEnd — see handleLegacyDecode.
    const sceneLinearStartMark = `maple:wasm-scene-linear:${req.id}:start`;
    markStart(sceneLinearStartMark);
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
    markEnd(
      sceneLinearStartMark,
      `maple:wasm-scene-linear:${req.id}:end`,
      sized ? `maple:wasm-scene-linear-sized:${req.maxLongEdge}` : `maple:wasm-scene-linear`,
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
    // #1123: markStart/markEnd — see handleLegacyDecode; a throw here must never
    // fall through to the outer `catch` and report a successful analysis as an error.
    const autoAdjustStartMark = `maple:auto-adjust:${req.id}:start`;
    markStart(autoAdjustStartMark);
    const result = compute_auto_adjustments_from_bytes(bytes, req.ext, req.xmp ?? undefined);
    markEnd(autoAdjustStartMark, `maple:auto-adjust:${req.id}:end`, 'maple:auto-adjust');
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
