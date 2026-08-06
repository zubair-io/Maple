/// <reference lib="webworker" />
// Worker-side one-shot decode handlers (legacy display-encoded + scene-linear).
//
// Split from `raw-pipeline.worker.ts` to keep that file inside the size budget
// (#2661 pushed it past the ceiling) — same precedent as
// `raw-pipeline.export-handler.ts`. `ensureReady` is injected by the worker
// (it owns the init promise + the one-time status broadcast).

import {
  default_target_long_edge,
  render_bytes,
  render_bytes_scene_linear,
  render_bytes_scene_linear_sized,
  render_bytes_sized,
} from './pkg/raw_wasm';
// Namespace import so the gpu-gated `render_bytes_gpu` (epic #925, P4b-web /
// #1029) can be accessed DYNAMICALLY: it exists only in the `gpu`-feature WASM
// build, so a named import would break the default (gpu-off) bundle.
import * as wasm from './pkg/raw_wasm';
import type { RawWasmInitResult } from './raw-wasm-init';
import type { DecodeRequest, DecodeSceneLinearRequest, WorkerResponse } from './raw-pipeline.types';
import { markStart, markEnd } from './raw-pipeline.perf';

/** The worker's lazily-shared WASM init — see `ensureReady` in the worker. */
type EnsureReady = () => Promise<RawWasmInitResult>;

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

export async function handleLegacyDecode(
  req: DecodeRequest,
  ensureReady: EnsureReady,
): Promise<void> {
  try {
    await ensureReady();
    const bytes = new Uint8Array(req.bytes);
    // Sized decode (#1101, spec §5.1): a `maxLongEdge` request routes to the
    // WASM-CPU sized entry — the editor's 2D fast/refine phases, whose
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
    //      WASM-CPU `render_bytes` path;
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
    // #1123: markStart/markEnd — a Performance Timeline throw here (e.g. a cleared
    // mark) must never fall through to the outer `catch` and mislabel a successful
    // decode as a `decode-error`.
    const wasmStartMark = `maple:wasm:${req.id}:start`;
    markStart(wasmStartMark);
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
        // SAME develop on the WASM-CPU sized entry at the identical default
        // cap the GPU call self-caps to (#2661 — the pre-fix retry ran
        // `render_bytes` at FULL sensor resolution, which both diverged from
        // the failed GPU develop it claims to repeat and OOM-aborted the wasm
        // instance outright on ≥~35 MP sensors). The outer catch still handles
        // a genuine CPU decode failure.
        console.warn(
          '[raw-pipeline.worker] GPU render failed; falling back to CPU render_bytes_sized:',
          gpuErr,
        );
        result = render_bytes_sized(
          bytes,
          req.ext,
          req.xmp ?? null,
          false,
          default_target_long_edge(),
        );
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
      // Unsized WASM-CPU path — full-res for sensors that fit the wasm heap.
      // No production caller sends unsized requests today (the editor's 2D
      // phases are always sized and the hosted-thumb fallback passes an
      // explicit cap), and the wasm entry itself memory-clamps sensors whose
      // full-res develop would exceed the 4 GiB wasm32 heap (#2661), so a
      // future unsized caller degrades to a clamped render instead of an
      // instance-poisoning OOM trap.
      result = render_bytes(bytes, req.ext, req.xmp ?? null);
    }
    markEnd(wasmStartMark, `maple:wasm:${req.id}:end`, markTag);
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

export async function handleSceneLinearDecode(
  req: DecodeSceneLinearRequest,
  ensureReady: EnsureReady,
): Promise<void> {
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
