/// <reference lib="webworker" />

import { render_bytes, render_bytes_scene_linear } from './pkg/raw_wasm';
// Namespace import so the gpu-gated `render_bytes_gpu` + `WebLiveSession` (epic
// #925, P4b-web / #1029, #1038) can be accessed DYNAMICALLY: they exist only in
// the `gpu`-feature WASM build, so a named import would break the default (gpu-off)
// bundle's type-check + load. We read them off the module object and existence-check
// before use.
import * as wasm from './pkg/raw_wasm';
import { initRawWasm, type RawWasmInitResult } from './raw-wasm-init';
import type {
  DecodeRequest,
  DecodeSceneLinearRequest,
  OpenSessionRequest,
  RenderSessionRequest,
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
  readonly width: number;
  readonly height: number;
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
      const ctor = liveSessionCtor();
      if (!ctor) {
        // gpu-off bundle (the default build) — no GPU live session. The component
        // falls back to the 2D `decode()` path on this error.
        postSessionError(
          req.id,
          'WebLiveSession unavailable: this WASM bundle was not built with the `gpu` feature',
        );
        return;
      }
      // Tear down any prior session before opening a new one (asset switch).
      liveSession?.free();
      liveSession = null;

      const bytes = new Uint8Array(req.bytes);
      performance.mark(`maple:session-open:${req.id}:start`);
      const session = await ctor.open(bytes, req.ext, req.xmp ?? null, req.canvas);
      performance.mark(`maple:session-open:${req.id}:end`);
      performance.measure(
        'maple:session-open',
        `maple:session-open:${req.id}:start`,
        `maple:session-open:${req.id}:end`,
      );
      liveSession = session;
      const response: WorkerResponse = {
        id: req.id,
        type: 'open-session-success',
        width: session.width,
        height: session.height,
        asShotTemperature: session.asShotTemperature,
        asShotTint: session.asShotTint,
        // The TRUTH the browser configured after the one-time display-p3 retag
        // `open` did (read back via `getConfiguration()`), never an assumption.
        colorSpace: session.colorSpace,
      };
      (self as unknown as Worker).postMessage(response);
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
      const colorSpace = await liveSession.render(req.xmp ?? null);
      performance.mark(`maple:session-render:${req.id}:end`);
      performance.measure(
        'maple:session-render',
        `maple:session-render:${req.id}:start`,
        `maple:session-render:${req.id}:end`,
      );
      const response: WorkerResponse = {
        id: req.id,
        type: 'render-session-success',
        colorSpace,
      };
      (self as unknown as Worker).postMessage(response);
    } catch (e) {
      const err = e instanceof Error ? e : null;
      if (err?.stack) {
        console.error('[raw-pipeline.worker] render-session threw:', err.message, err.stack);
      }
      postSessionError(req.id, err?.message ?? String(e));
    }
  });
}

function handleCloseSession(): void {
  // No enqueue — `free()` must not run while a render holds the borrow, but the
  // chain guarantees ordering: close after the in-flight op via the same queue.
  void enqueueSessionOp(async () => {
    liveSession?.free();
    liveSession = null;
  });
}
