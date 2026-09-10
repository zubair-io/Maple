import { cameraSupportFromJson } from '../state/camera-support';
import { lensProfileFromJson } from '../lens/lens-profile.metadata';
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
  readbackScopeSnapshot,
  setLiveCanvas,
} from './raw-pipeline.worker-handlers';
import { markStart, markEnd, markScopeReadback } from './raw-pipeline.perf';

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

// ── Out-of-band scope sampling (#3397) ───────────────────────────────────────
// Renders admitted onto `sessionChain` but not yet finished. A deferred scope
// sample is skipped while this is non-zero: a newer frame is already on its way
// and will publish its own sample, and scopes describe the frame on screen, so
// dropping a superseded sample is correct rather than merely tolerable.
let queuedRenders = 0;
// Coalesces bursts — one pending timer at a time, not one per render tick.
let scopeSampleScheduled = false;
// Perf-mark id for the sample, so the readback measure still names the render
// that produced the frame being sampled.
let lastRenderId = 0;

/**
 * Read back the presented frame and broadcast it, unless a newer render is
 * already queued. Runs OUTSIDE `sessionChain` and after the render reply has
 * been posted, so its GPU sync never sits inside the acknowledgement the
 * editor's latest-wins scheduler waits on (#3397).
 */
function publishScopeSample(): void {
  if (queuedRenders > 0) return;
  const scope = markScopeReadback(lastRenderId, () => readbackScopeSnapshot());
  if (!scope) return;
  const response: WorkerResponse = { id: 0, type: 'scope-sample', scope };
  (self as unknown as Worker).postMessage(response, [scope.rgb]);
}

/** Defer one coalesced sample to a later task, after the reply has gone out. */
function scheduleScopeSample(): void {
  if (scopeSampleScheduled) return;
  scopeSampleScheduled = true;
  setTimeout(() => {
    scopeSampleScheduled = false;
    publishScopeSample();
  }, 0);
}

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

/**
 * Builds and posts the `open-session-success` response, including the scope
 * readback (#1045, #1930): marked SEPARATELY from `maple:session-open` — a
 * real GPU-sync cost (drawImage from the presented canvas + a synchronous
 * pixel readback) with nothing to do with the render the `session-open`
 * measure times, so folding it into that window would hide the cost it's
 * meant to isolate. `markScopeReadback` guards its own clearMarks/
 * clearMeasures cleanup independently (#1123), so a `measure` throw can't
 * skip a clear and leak marks into the buffer.
 */
function postOpenSessionSuccess(req: OpenSessionRequest, session: WebLiveSessionInstance): void {
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
    // #3182 — decode-time facts, read off the session's retained RawImage.
    hasLensCorrections: session.hasLensCorrections,
    lensCorrectionCaInert: session.lensCorrectionCaInert,
    cameraSupport: cameraSupportFromJson(session.cameraSupportJson),
    lensProfile: lensProfileFromJson(session.lensProfileJson), // #3479
    // The TRUTH the browser configured after the one-time display-p3 retag
    // `open` did (read back via `getConfiguration()`), never an assumption.
    colorSpace: session.colorSpace,
    // Downsampled RGB readback of the first frame for the scopes (#1045);
    // undefined on any readback failure → scopes keep their pseudo fallback.
    scope: scope ?? undefined,
  };
  // Transfer the snapshot buffer when present (small; avoids a main-thread copy).
  (self as unknown as Worker).postMessage(response, scope ? [scope.rgb] : []);
}

async function openSessionOp(req: OpenSessionRequest): Promise<void> {
  try {
    await ensureReady();
    const ctor = requireLiveSessionCtor(req.id);
    if (!ctor) return;

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
      // Requested canvas colour space (#3191) — `undefined` preserves the
      // WASM-side `'display-p3'` default.
      req.targetColorSpace,
    );
    markEnd(sessionOpenStartMark, `maple:session-open:${req.id}:end`, 'maple:session-open');
    liveSession = session;
    // Retain the canvas (the readback source) — `open()` did not neuter the JS ref.
    // `open` already presented the first frame, so a snapshot here reflects it.
    setLiveCanvas(req.canvas);

    postOpenSessionSuccess(req, session);
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

/**
 * Post the `render-session-success` reply, then schedule the scope readback
 * to happen after it (#3397).
 *
 * This reply is what settles the render promise, and the editor's latest-wins
 * scheduler cannot dispatch the next adjustment until it lands. The readback
 * is a synchronous GPU→CPU sync (`drawImage` off the presented canvas, then
 * `getImageData`), so doing it first — as this did through #1045/#1930 — put
 * that sync inside the acknowledgement and stalled edit dispatch well past the
 * 50ms budget while the render/submit itself measured ~3ms.
 *
 * The sample now leaves separately as a `scope-sample` broadcast. It is still
 * marked apart from `maple:session-render` (#1930) so its cost stays visible
 * rather than folded into the render window, and `markScopeReadback` still
 * guards its own clearMarks/clearMeasures cleanup (#1123, jules review) so a
 * `measure` throw cannot skip a clear and leak marks.
 */
function postRenderSessionSuccess(
  req: RenderSessionRequest,
  session: WebLiveSessionInstance,
  colorSpace: string,
): void {
  const response: WorkerResponse = {
    id: req.id,
    type: 'render-session-success',
    colorSpace,
    // #3479: a scalar-params tick never re-develops, so only an XMP render
    // can have changed which imported profile the prefix consumed.
    lensProfile: req.params ? undefined : lensProfileFromJson(session.lensProfileJson),
  };
  (self as unknown as Worker).postMessage(response);
  lastRenderId = req.id;
  scheduleScopeSample();
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
    postRenderSessionSuccess(req, liveSession, colorSpace);
  } catch (e) {
    const err = e instanceof Error ? e : null;
    if (err?.stack) {
      console.error('[raw-pipeline.worker] render-session threw:', err.message, err.stack);
    }
    postSessionError(req.id, err?.message ?? String(e));
  }
}

export async function handleRenderSession(req: RenderSessionRequest): Promise<void> {
  // Counted on ADMISSION, not on start (#3397): the check that matters to a
  // deferred sample is "is another frame coming", and a render sitting behind
  // this one on `sessionChain` already answers yes. Decremented in a `finally`
  // so an error path cannot strand the counter above zero and mute the scopes
  // for the rest of the session.
  queuedRenders += 1;
  try {
    await enqueueSessionOp(() => renderSessionOp(req));
  } finally {
    queuedRenders -= 1;
  }
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
    liveSession?.free();
    liveSession = null;
    // Drop the readback source too (its control was transferred to the worker; the
    // element is owned by the now-closed session). A re-open installs a fresh one.
    setLiveCanvas(null);
  });
}
