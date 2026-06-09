/// <reference lib="webworker" />

import { render_bytes, render_bytes_scene_linear } from './pkg/raw_wasm';
// Namespace import so the gpu-gated `render_bytes_gpu` (epic #925, P4b-web /
// #1029) can be accessed DYNAMICALLY: it exists only in the `gpu`-feature WASM
// build, so a named import would break the default (gpu-off) bundle's type-check
// + load. We read it off the module object and existence-check before calling.
import * as wasm from './pkg/raw_wasm';
import { initRawWasm, type RawWasmInitResult } from './raw-wasm-init';
import type { DecodeRequest, DecodeSceneLinearRequest, WorkerResponse } from './raw-pipeline.types';

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

addEventListener(
  'message',
  async (event: MessageEvent<DecodeRequest | DecodeSceneLinearRequest>) => {
    const req = event.data;
    if (req.type === 'decode') {
      await handleLegacyDecode(req);
      return;
    }
    if (req.type === 'decode-scene-linear') {
      await handleSceneLinearDecode(req);
      return;
    }
    // Unknown request type — silently ignore (matches the prior early-return shape).
  },
);

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
    // Route through the GPU live chain when the request opts in (#1029) AND the
    // loaded bundle actually exports it; otherwise fall back to the WASM-CPU
    // `render_bytes`. Flag-on against a gpu-off bundle (the default build) thus
    // renders correctly via the CPU path rather than throwing.
    const gpuFn = req.gpu ? gpuEntry() : null;
    // Worker-local mark so DevTools' Performance panel shows the WASM render
    // call as a distinct entry independent of the main-thread round-trip the
    // service brackets. The mark name distinguishes the GPU path for profiling.
    const markTag = gpuFn ? 'maple:wasm-gpu' : 'maple:wasm';
    performance.mark(`maple:wasm:${req.id}:start`);
    const result = gpuFn
      ? await gpuFn(bytes, req.ext, req.xmp ?? null)
      : render_bytes(bytes, req.ext, req.xmp ?? null);
    performance.mark(`maple:wasm:${req.id}:end`);
    performance.measure(markTag, `maple:wasm:${req.id}:start`, `maple:wasm:${req.id}:end`);
    const rgb = result.rgb;
    const buffer = rgb.buffer.slice(rgb.byteOffset, rgb.byteOffset + rgb.byteLength);
    const response: WorkerResponse = {
      id: req.id,
      type: 'decode-success',
      width: result.width,
      height: result.height,
      rgb: buffer,
      asShotTemperature: result.as_shot_temperature,
      asShotTint: result.as_shot_tint,
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
    // Worker-local mark mirrors the legacy `maple:wasm` perf entry.
    performance.mark(`maple:wasm-scene-linear:${req.id}:start`);
    const result = render_bytes_scene_linear(bytes, req.ext, req.xmp ?? null, req.qualityPreview);
    performance.mark(`maple:wasm-scene-linear:${req.id}:end`);
    performance.measure(
      `maple:wasm-scene-linear`,
      `maple:wasm-scene-linear:${req.id}:start`,
      `maple:wasm-scene-linear:${req.id}:end`,
    );
    // wasm-bindgen returns a Uint16Array; slice its underlying buffer so
    // we can transfer it (avoid the main thread holding a copy).
    const lanes = result.fp16_rgba;
    const buffer = lanes.buffer.slice(
      lanes.byteOffset,
      lanes.byteOffset + lanes.byteLength,
    ) as ArrayBuffer;
    const response: WorkerResponse = {
      id: req.id,
      type: 'decode-scene-linear-success',
      width: result.width,
      height: result.height,
      fp16Rgba: buffer,
      asShotTemperature: result.as_shot_temperature,
      asShotTint: result.as_shot_tint,
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
