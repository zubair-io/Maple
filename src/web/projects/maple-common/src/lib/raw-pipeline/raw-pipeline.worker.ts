/// <reference lib="webworker" />

import { compute_auto_adjustments_from_bytes } from './pkg/raw_wasm';
// Namespace import so the gpu-gated `WebLiveSession` (epic #925, P4b-web /
// #1038) can be accessed DYNAMICALLY: it exists only in the `gpu`-feature WASM
// build, so a named import would break the default (gpu-off) bundle's
// type-check + load. We read it off the module object and existence-check
// before use.
import * as wasm from './pkg/raw_wasm';
import { initRawWasm, type RawWasmInitResult } from './raw-wasm-init';
import type {
  AutoAdjustRequest,
  DeepDenoiseProgress,
  OpenSessionRequest,
  RenderSessionRequest,
  WorkerResponse,
  WorkerRequest,
} from './raw-pipeline.types';
import {
  type WebLiveSessionInstance,
  type WebLiveSessionCtor,
  readbackScopeSnapshot,
  setLiveCanvas,
} from './raw-pipeline.worker-handlers';
import { markStart, markEnd, markScopeReadback } from './raw-pipeline.perf';
import { handleExport } from './raw-pipeline.export-handler';
import { handleLegacyDecode, handleSceneLinearDecode } from './raw-pipeline.decode-handlers';

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

/**
 * #1153: hand raw-core's BM3D stage progress to the main thread.
 *
 * `setDeepDenoiseProgress` is a plain (non-gpu-gated) export of the WASM
 * bundle, but read dynamically for the same reason `render_bytes_gpu` is:
 * a bundle built before #1153 simply omits it, and a missing determinate
 * bar must not break decoding. Ticks only fire while `deepDenoise > 0`
 * engages the stage, so a session that never touches Deep pays nothing.
 *
 * The develop runs SYNCHRONOUSLY here, so the worker cannot answer a poll
 * while it is in flight — but this outgoing `postMessage` still lands on
 * the main thread's (unblocked) event loop, which is why the direction is
 * push, not pull.
 */
function installDeepDenoiseProgress(): void {
  const register = Reflect.get(wasm as object, 'setDeepDenoiseProgress');
  if (typeof register !== 'function') return;
  (register as (cb: (pass: string, fraction: number) => void) => void)((pass, fraction) => {
    const msg: DeepDenoiseProgress = {
      id: 0,
      type: 'deep-denoise-progress',
      pass: pass === 'pass 2/2' ? 2 : 1,
      fraction,
    };
    (self as unknown as Worker).postMessage(msg);
  });
}

let readyPromise: Promise<RawWasmInitResult> | null = null;

function ensureReady(): Promise<RawWasmInitResult> {
  if (!readyPromise) {
    readyPromise = initRawWasm().then((result) => {
      installDeepDenoiseProgress();
      // Report the runtime policy result so the UI can surface serial mode on
      // non-isolated hosts and on Chromium while #2515 is mitigated.
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
      await handleLegacyDecode(req, ensureReady);
      return;
    case 'decode-scene-linear':
      await handleSceneLinearDecode(req, ensureReady);
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
    case 'export':
      await handleExport(req);
      return;
    default:
      // Unknown request type — silently ignore (matches the prior early-return).
      return;
  }
});

// ── Persistent GPU live session (epic #925, P4b-web / #1038) ─────────────────
// The worker owns ONE `WebLiveSession` (the GPU-resident state for the focused
// image). `open-session` builds it + presents the first frame; `render-session`
// re-renders for an edit (#846) and presents — both straight to the transferred
// `OffscreenCanvas`, NO CPU readback. The handle is wasm-only (`gpu`-feature build);
// against a gpu-off bundle the open reports an error and the component falls back
// to the 2D `decode()` path.

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
      // Gate the GPU session on BOTH the bundle exporting `WebLiveSession` AND the
      // runtime advertising WebGPU. The shipped bundle now co-builds the `gpu`
      // feature (#1059), so `liveSessionCtor()` is non-null on EVERY browser —
      // the `'gpu' in navigator` check is what keeps a no-WebGPU browser from
      // attempting (and failing) to open a session. Either miss posts a
      // session-error → the component (`ImageCanvasGpuPresent.open`) falls back to
      // the 2D `decode()` path, which on a no-WebGPU runtime routes WASM-CPU.
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
      setLiveCanvas(null);

      const bytes = new Uint8Array(req.bytes);
      // #1123: markStart/markEnd — a Performance Timeline throw here must never fall
      // through to the outer `catch` and report a successful session open as a
      // `session-error` (the session would then be leaked: opened in wasm, but
      // never recorded as `liveSession`, and never reported to the caller).
      const sessionOpenStartMark = `maple:session-open:${req.id}:start`;
      markStart(sessionOpenStartMark);
      const session = await ctor.open(
        bytes,
        req.ext,
        req.xmp ?? null,
        req.canvas,
        // Viewport target (#1080): the develop + canvas are fit to it, so the
        // session never configures an over-texture-cap (full-sensor-res) surface.
        req.maxLongEdge,
      );
      markEnd(sessionOpenStartMark, `maple:session-open:${req.id}:end`, 'maple:session-open');
      liveSession = session;
      // Retain the canvas (the readback source) — `open()` did not neuter the JS ref.
      // `open` already presented the first frame, so a snapshot here reflects it.
      setLiveCanvas(req.canvas);
      // Marked SEPARATELY from `maple:session-open` above (#1930): this is a
      // real GPU-sync cost (drawImage from the presented canvas + a
      // synchronous pixel readback) that has nothing to do with the render
      // the `session-open` measure is timing — folding it into that window
      // (by reading back before the `:end` mark) would hide the render cost
      // it's meant to isolate. Reported as its own measure instead.
      // #1123: markScopeReadback — see raw-pipeline.perf.ts. Every Performance
      // Timeline call it makes (including its own clearMarks/clearMeasures
      // cleanup) is independently guarded, so a `measure` throw can't skip a
      // clear that comes after it and leak marks into the buffer.
      const scope = markScopeReadback(req.id, () => readbackScopeSnapshot());
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
      // #1123: markStart/markEnd — see handleOpenSession; a throw here must never
      // fall through to the outer `catch` and report a successful render as a
      // `session-error` (the frame is already presented to the canvas by then).
      const sessionRenderStartMark = `maple:session-render:${req.id}:start`;
      markStart(sessionRenderStartMark);
      let colorSpace: string;
      if (req.params) {
        colorSpace = await liveSession.render_with_params(req.params);
      } else {
        colorSpace = await liveSession.render(req.xmp ?? null);
      }
      markEnd(sessionRenderStartMark, `maple:session-render:${req.id}:end`, 'maple:session-render');
      // Read back the just-presented frame for the scopes (#1045). The render is
      // serialized on `sessionChain`, so the canvas holds this edit's frame here;
      // null on any failure → the scopes keep their previous (or pseudo) data.
      // Marked SEPARATELY from `maple:session-render` above (#1930) — same
      // reasoning as `handleOpenSession`: the readback is a real GPU-sync
      // cost with no bearing on the render-loop tick the other measure times,
      // so it gets its own measure instead of hiding inside (or inflating) that
      // one. `markScopeReadback` guards its own clearMarks/clearMeasures cleanup
      // independently (#1123, jules review) so a `measure` throw can't skip it.
      const scope = markScopeReadback(req.id, () => readbackScopeSnapshot());
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

function handleCloseSession(): void {
  // Enqueue the free so it runs AFTER any in-flight render — `free()` must not run
  // while a render holds the wasm `&mut self` borrow (that throws). The shared queue
  // guarantees the ordering. Fire-and-forget (no reply).
  void enqueueSessionOp(async () => {
    liveSession?.free();
    liveSession = null;
    // Drop the readback source too (its control was transferred to the worker; the
    // element is owned by the now-closed session). A re-open installs a fresh one.
    setLiveCanvas(null);
  });
}
