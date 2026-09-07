import { cameraSupportFromJson } from '../state/camera-support';
/// <reference lib="webworker" />
// raw-pipeline.session-handler.ts
// Extracted from raw-pipeline.worker.ts (pure code move — no behaviour change,
// plus the additive `handleSetFilmLut`, epic #2683 Task 9) to keep the main
// worker entry inside the file-size budget. Same split pattern as
// raw-pipeline.export-handler.ts.
//
// ── Persistent GPU live session (epic #925, P4b-web / #1038) ─────────────────
// The worker owns ONE `WebLiveSession` (the GPU-resident state for the focused
// image). `open-session` builds it + presents the first frame; `render-session`
// re-renders for an edit (#846) and presents — both straight to the transferred
// `OffscreenCanvas`, NO CPU readback. The handle is wasm-only (`gpu`-feature build);
// against a gpu-off bundle the open reports an error and the component falls back
// to the 2D `decode()` path. `set-film-lut` (Task 9) loads/clears the session's
// film-look grid — folded into the NEXT render tick, not itself a render.

import * as wasm from './pkg/raw_wasm';
import type {
  OpenSessionRequest,
  RenderSessionRequest,
  SetFilmLutRequest,
  WorkerResponse,
} from './raw-pipeline.types';
import {
  type WebLiveSessionInstance,
  type WebLiveSessionCtor,
  ensureReady,
} from './raw-pipeline.worker-handlers';
import { markStart, markEnd } from './raw-pipeline.perf';
import { SessionScopeReadback } from './raw-pipeline.scope-readback';

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

// Only sampler submission enters sessionChain. Its owned map Promise never does.
const scopeReadback = new SessionScopeReadback(
  (operation) => {
    void enqueueSessionOp(async () => {
      operation();
    });
  },
  (update) => (self as unknown as Worker).postMessage(update, [update.scope.rgb]),
);

function postSessionError(id: number, message: string): void {
  const response: WorkerResponse = { id, type: 'session-error', message };
  (self as unknown as Worker).postMessage(response);
}

/**
 * Gate the GPU session on BOTH the bundle exporting `WebLiveSession` AND the
 * runtime advertising WebGPU. The shipped bundle now co-builds the `gpu`
 * feature (#1059), so `liveSessionCtor()` is non-null on EVERY browser — the
 * `'gpu' in navigator` check is what keeps a no-WebGPU browser from attempting
 * (and failing) to open a session. Posts a session-error and returns null on
 * either miss, so the caller can just early-return — the component
 * (`ImageCanvasGpuPresent.open`) falls back to the 2D `decode()` path, which
 * on a no-WebGPU runtime routes WASM-CPU.
 */
function requireLiveSessionCtor(id: number): WebLiveSessionCtor | null {
  const gpuAdvertised = 'gpu' in navigator;
  const ctor = gpuAdvertised ? liveSessionCtor() : null;
  if (ctor) return ctor;
  postSessionError(
    id,
    gpuAdvertised
      ? 'WebLiveSession unavailable: this WASM bundle was not built with the `gpu` feature'
      : 'WebLiveSession unavailable: this browser does not expose WebGPU (navigator.gpu)',
  );
  return null;
}

/** Reply after presentation; bounded scope pixels arrive independently. */
function postOpenSessionSuccess(req: OpenSessionRequest, session: WebLiveSessionInstance): void {
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
    // #3182 — decode-time facts, read off the session's retained RawImage.
    hasLensCorrections: session.hasLensCorrections,
    lensCorrectionCaInert: session.lensCorrectionCaInert,
    cameraSupport: cameraSupportFromJson(session.cameraSupportJson),
    // The TRUTH the browser configured after the one-time display-p3 retag
    // `open` did (read back via `getConfiguration()`), never an assumption.
    colorSpace: session.colorSpace,
  };
  (self as unknown as Worker).postMessage(response);
}

async function openSessionOp(req: OpenSessionRequest): Promise<void> {
  try {
    await ensureReady();
    const ctor = requireLiveSessionCtor(req.id);
    if (!ctor) return;

    // Tear down any prior session before opening a new one (asset switch).
    scopeReadback.close();
    liveSession?.free();
    liveSession = null;

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
      // Requested canvas colour space (#3191) — `undefined` preserves the
      // WASM-side `'display-p3'` default.
      req.targetColorSpace,
    );
    markEnd(sessionOpenStartMark, `maple:session-open:${req.id}:end`, 'maple:session-open');
    liveSession = session;
    postOpenSessionSuccess(req, session);
    scopeReadback.open(req.id, session);
  } catch (e) {
    const err = e instanceof Error ? e : null;
    if (err?.stack) {
      console.error('[raw-pipeline.worker] open-session threw:', err.message, err.stack);
    }
    postSessionError(req.id, err?.message ?? String(e));
  }
}

export async function handleOpenSession(req: OpenSessionRequest): Promise<void> {
  await enqueueSessionOp(() => openSessionOp(req));
}

/** Runs the actual wasm render call — the params-patch path or the XMP-reparse fallback. */
async function renderLiveSessionFrame(
  req: RenderSessionRequest,
  session: WebLiveSessionInstance,
): Promise<string> {
  return req.params ? session.render_with_params(req.params) : session.render(req.xmp ?? null);
}

/** Release the edit scheduler before any asynchronous scope map completes. */
function postRenderSessionSuccess(req: RenderSessionRequest, colorSpace: string): void {
  const response: WorkerResponse = {
    id: req.id,
    type: 'render-session-success',
    colorSpace,
  };
  (self as unknown as Worker).postMessage(response);
}

async function renderSessionOp(req: RenderSessionRequest): Promise<void> {
  if (!liveSession) {
    postSessionError(req.id, 'render-session: no open session');
    return;
  }
  try {
    // #1123: markStart/markEnd — see openSessionOp; a throw here must never
    // fall through to the outer `catch` and report a successful render as a
    // `session-error` (the frame is already presented to the canvas by then).
    const sessionRenderStartMark = `maple:session-render:${req.id}:start`;
    markStart(sessionRenderStartMark);
    const colorSpace = await renderLiveSessionFrame(req, liveSession);
    markEnd(sessionRenderStartMark, `maple:session-render:${req.id}:end`, 'maple:session-render');
    postRenderSessionSuccess(req, colorSpace);
    scopeReadback.presented(req.id);
  } catch (e) {
    const err = e instanceof Error ? e : null;
    if (err?.stack) {
      console.error('[raw-pipeline.worker] render-session threw:', err.message, err.stack);
    }
    postSessionError(req.id, err?.message ?? String(e));
  }
}

export async function handleRenderSession(req: RenderSessionRequest): Promise<void> {
  await enqueueSessionOp(() => renderSessionOp(req));
}

/**
 * Load (or clear) the open session's film-look LUT (epic #2683, Task 9).
 * Enqueued on the same `sessionChain` as `open`/`render`/`close` — it writes
 * `&mut self` fields on the live wasm object, so it must not race a render
 * that holds the mutable borrow across its own awaits (the same re-entrancy
 * hazard `enqueueSessionOp`'s doc explains). Synchronous on the wasm side
 * (no GPU work — the loaded grid only takes effect on the NEXT render tick),
 * so this resolves as soon as its turn in the queue comes up.
 */
export async function handleSetFilmLut(req: SetFilmLutRequest): Promise<void> {
  await enqueueSessionOp(async () => {
    if (!liveSession) {
      postSessionError(req.id, 'set-film-lut: no open session');
      return;
    }
    try {
      liveSession.set_film_lut(new Uint8Array(req.bytes), req.lookKey);
      const response: WorkerResponse = { id: req.id, type: 'set-film-lut-success' };
      (self as unknown as Worker).postMessage(response);
    } catch (e) {
      const err = e instanceof Error ? e : null;
      if (err?.stack) {
        console.error('[raw-pipeline.worker] set-film-lut threw:', err.message, err.stack);
      }
      postSessionError(req.id, err?.message ?? String(e));
    }
  });
}

export function handleCloseSession(): void {
  // Enqueue the free so it runs AFTER any in-flight render — `free()` must not run
  // while a render holds the wasm `&mut self` borrow (that throws). The shared queue
  // guarantees the ordering. Fire-and-forget (no reply).
  void enqueueSessionOp(async () => {
    scopeReadback.close();
    liveSession?.free();
    liveSession = null;
  });
}
