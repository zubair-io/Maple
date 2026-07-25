// RawPipelineService — Angular wrapper around the raw-decode Web Worker.
// Lazy-creates the worker on first call, reuses for subsequent calls,
// terminates on app destroy. All decodes run off the main thread.
//
// T10: exposes `isThreaded$` (Observable<boolean>) so UI can surface a
// "single-threaded mode" indicator on browsers without cross-origin isolation
// (Safari / Firefox default, or any host without COOP+COEP). The observable
// starts undefined and emits once the worker's WASM init reports back.

import { Injectable, OnDestroy, inject, signal } from '@angular/core';
import { BehaviorSubject, Observable } from 'rxjs';
import type {
  AutoAdjustPatch,
  AutoAdjustRequest,
  DecodedImage,
  DecodedSceneLinearImage,
  DecodeRequest,
  DecodeSceneLinearRequest,
  OpenSessionRequest,
  RenderSessionRequest,
  CloseSessionRequest,
  ExportedFile,
  RawExportOptions,
  ScopeSnapshot,
  WorkerResponse,
} from './raw-pipeline.types';
import { dispatchExport } from './raw-pipeline.export-request';

export type { AutoAdjustPatch } from './raw-pipeline.types';
import { GPU_LIVE_RENDER_ENABLED } from './gpu-live-render.token';
import { isNonRawExtension } from '../state/raw-extensions';
import { decodeNonRawToRgb, decodeNonRawToSceneLinear } from './image-utils';
import type {
  OpenedLiveSession,
  PendingHandler,
  RenderedLiveSession,
} from './raw-pipeline.service-internals';
export type { OpenedLiveSession, RenderedLiveSession } from './raw-pipeline.service-internals';
import { markStart, markEnd } from './raw-pipeline.perf';

@Injectable({ providedIn: 'root' })
export class RawPipelineService implements OnDestroy {
  // Routes the legacy display-encoded `decode()` through the GPU live chain
  // (`render_bytes_gpu`) when true (epic #925, P4b-web / #1029). Off by default
  // → the WASM-CPU `render_bytes` path, byte-for-byte today. The worker further
  // gates on whether the loaded bundle exports the GPU entry, so flag-on against
  // a gpu-off WASM build still falls back to `render_bytes`.
  private readonly gpuLiveRender = inject(GPU_LIVE_RENDER_ENABLED);

  private worker: Worker | null = null;
  private nextId = 1;
  private pending = new Map<number, PendingHandler>();

  /** Pack a worker `ScopeSnapshot` reply into a `DecodedImage` for `currentPixels`. */
  private scopeToDecoded(scope: ScopeSnapshot | undefined): DecodedImage | undefined {
    if (!scope) return undefined;
    return {
      width: scope.width,
      height: scope.height,
      rgb: new Uint8Array(scope.rgb),
      // The scopes ignore WB; these are placeholders (a readback has no As-Shot WB).
      asShotTemperature: 6500,
      asShotTint: 0,
    };
  }

  // T10: threaded-state signal. `null` = not yet reported by the worker.
  private readonly threadedSubject = new BehaviorSubject<boolean | null>(null);
  private readonly threadCountSubject = new BehaviorSubject<number>(1);

  /** Emits once the Web Worker has initialised the WASM thread pool. */
  readonly isThreaded$: Observable<boolean | null> = this.threadedSubject.asObservable();

  /** Emits the number of rayon worker threads (1 when single-threaded). */
  readonly threadCount$: Observable<number> = this.threadCountSubject.asObservable();

  /**
   * #1153: live BM3D deep-denoise progress, or `null` when the stage is not
   * running. Fed by the worker's `deep-denoise-progress` broadcast, which
   * carries raw-core's own per-reference-row ticks — the editor binds this
   * to a DETERMINATE indicator, never a simulated one.
   *
   * Cleared when the request the develop belonged to settles (below): the
   * stage itself has no "finished" tick, and the render still has GPU work
   * to do after the last one.
   */
  readonly deepDenoiseProgress = signal<{ pass: 1 | 2; fraction: number } | null>(null);

  private ensureWorker(): Worker {
    if (this.worker) return this.worker;
    try {
      this.worker = new Worker(new URL('./raw-pipeline.worker', import.meta.url), {
        type: 'module',
      });
      this.worker.addEventListener('message', (e: MessageEvent<WorkerResponse>) => {
        const msg = e.data;
        if (msg.type === 'worker-log') {
          const prefix = '[raw-pipeline worker]';
          if (msg.level === 'error') console.error(prefix, msg.text);
          else if (msg.level === 'warn') console.warn(prefix, msg.text);
          else console.log(prefix, msg.text);
          return;
        }
        if (msg.type === 'status') {
          this.threadedSubject.next(msg.threaded);
          this.threadCountSubject.next(msg.threads);
          return;
        }
        if (msg.type === 'deep-denoise-progress') {
          this.deepDenoiseProgress.set({ pass: msg.pass, fraction: msg.fraction });
          return;
        }
        const handler = this.pending.get(msg.id);
        if (!handler) return;
        this.pending.delete(msg.id);
        // Any terminal reply ends the develop that emitted the ticks.
        this.deepDenoiseProgress.set(null);
        if (msg.type === 'decode-success' && handler.kind === 'legacy') {
          handler.resolve({
            width: msg.width,
            height: msg.height,
            nativeWidth: msg.nativeWidth,
            nativeHeight: msg.nativeHeight,
            rgb: new Uint8Array(msg.rgb),
            asShotTemperature: msg.asShotTemperature,
            asShotTint: msg.asShotTint,
          });
        } else if (msg.type === 'decode-error' && handler.kind === 'legacy') {
          handler.reject(new Error(msg.message));
        } else if (msg.type === 'decode-scene-linear-success' && handler.kind === 'scene-linear') {
          handler.resolve({
            width: msg.width,
            height: msg.height,
            nativeWidth: msg.nativeWidth,
            nativeHeight: msg.nativeHeight,
            fp16Rgba: new Uint16Array(msg.fp16Rgba),
            asShotTemperature: msg.asShotTemperature,
            asShotTint: msg.asShotTint,
          });
        } else if (msg.type === 'decode-scene-linear-error' && handler.kind === 'scene-linear') {
          handler.reject(new Error(msg.message));
        } else if (msg.type === 'open-session-success' && handler.kind === 'open-session') {
          handler.resolve({
            width: msg.width,
            height: msg.height,
            nativeWidth: msg.nativeWidth,
            nativeHeight: msg.nativeHeight,
            asShotTemperature: msg.asShotTemperature,
            asShotTint: msg.asShotTint,
            colorSpace: msg.colorSpace,
            scopePixels: this.scopeToDecoded(msg.scope),
          });
        } else if (msg.type === 'render-session-success' && handler.kind === 'render-session') {
          handler.resolve({
            colorSpace: msg.colorSpace,
            scopePixels: this.scopeToDecoded(msg.scope),
          });
        } else if (
          msg.type === 'session-error' &&
          (handler.kind === 'open-session' || handler.kind === 'render-session')
        ) {
          handler.reject(new Error(msg.message));
        } else if (msg.type === 'auto-adjust-success' && handler.kind === 'auto-adjust') {
          handler.resolve(msg.patch);
        } else if (msg.type === 'auto-adjust-error' && handler.kind === 'auto-adjust') {
          handler.reject(new Error(msg.message));
        } else if (msg.type === 'export-success' && handler.kind === 'export') {
          handler.resolve({
            width: msg.width,
            height: msg.height,
            extension: msg.extension,
            blob: msg.blob,
          });
        } else if (msg.type === 'export-error' && handler.kind === 'export') {
          handler.reject(new Error(msg.message));
        } else {
          // Mismatched response type and handler kind — should never happen
          // because ids are unique and the worker only emits success/error
          // matching the request type. Reject defensively to avoid hangs.
          handler.reject(new Error(`raw-pipeline: handler kind mismatch (${msg.type})`));
        }
      });
      this.worker.addEventListener('error', (e) => {
        console.error('RawPipelineWorker error:', e.message);
        this.deepDenoiseProgress.set(null);
        // Reject all pending on worker crash.
        this.pending.forEach(({ reject }) => reject(new Error(`Worker error: ${e.message}`)));
        this.pending.clear();
        this.worker = null;
      });
    } catch (err) {
      console.error('Failed to create RawPipelineWorker:', err);
      throw err;
    }
    return this.worker;
  }

  // Serialization gate: the worker's `message` handler is async, so multiple
  // concurrent decode requests would be in-flight at once and each one holds
  // hundreds of MB of zero-initialized f32 scratch buffers in WASM memory.
  // Two large decodes running together blow past the 4 GiB wasm32 cap and
  // abort with `RuntimeError: unreachable`. Queue them here so exactly one
  // decode sits in the worker at any moment.
  private decodeChain: Promise<unknown> = Promise.resolve();

  /**
   * @param maxLongEdge Cap the render's long edge in REAL (backing-store)
   *   pixels (#1101, spec §5.1) — the editor passes viewport × devicePixelRatio
   *   for the fast phase. Routes the threaded-CPU sized entry
   *   (`render_bytes_sized`): the develop downsamples right after demosaic so
   *   every later stage runs at the capped size. Never upscales; the reply
   *   carries the NATIVE oriented dims in `nativeWidth`/`nativeHeight` so the
   *   caller keeps its fit/100% zoom math. Absent ⇒ full-res `render_bytes`,
   *   byte-for-byte today's behaviour. (PR #1096 gives the GPU one-shot route
   *   the same cap — same field, same units.)
   * @param qualityPreview Only honoured with `maxLongEdge`: `true` runs the
   *   half-res Preview demosaic (the fast-phase cost profile), `false`/absent
   *   runs Full (the refine phase).
   *
   * Non-RAW images decode browser-natively at their full size — they're
   * already display-encoded and cheap to draw; sizing them is the canvas's
   * draw transform's job.
   */
  decode(
    bytes: Uint8Array,
    ext: string,
    xmp?: string,
    maxLongEdge?: number,
    qualityPreview?: boolean,
  ): Promise<DecodedImage> {
    // Non-RAW images (jpg/png/heic/webp/…) are already developed sRGB pixels —
    // decode them browser-natively, mirroring Apple's ImageIO path. They never
    // touch the WASM RAW heap, so this runs outside the serialization gate and
    // the buffer is never transferred into the worker.
    if (isNonRawExtension(ext)) {
      return decodeNonRawToRgb(bytes);
    }
    const run = () => this.decodeOnce(bytes, ext, xmp, maxLongEdge, qualityPreview);
    const next = this.decodeChain.then(run, run);
    // Preserve the chain regardless of success/failure so one bad decode
    // doesn't stall the queue.
    this.decodeChain = next.catch(() => undefined);
    return next;
  }

  private decodeOnce(
    bytes: Uint8Array,
    ext: string,
    xmp?: string,
    maxLongEdge?: number,
    qualityPreview?: boolean,
  ): Promise<DecodedImage> {
    let worker: Worker;
    try {
      worker = this.ensureWorker();
    } catch {
      return Promise.reject(new Error('RawPipelineService: worker unavailable'));
    }
    const id = this.nextId++;
    // Transfer the underlying buffer so the main thread doesn't keep a copy.
    const buffer = bytes.buffer.slice(
      bytes.byteOffset,
      bytes.byteOffset + bytes.byteLength,
    ) as ArrayBuffer;
    const request: DecodeRequest = {
      id,
      type: 'decode',
      bytes: buffer,
      ext,
      xmp,
      // GPU live-render routing (#1029). Only the legacy display-encoded path
      // (this method) participates; the scene-linear WebGL2 path is unchanged.
      // The worker ignores it for sized requests (they are the editor's 2D
      // CPU fast/refine phases — the GPU path uses the persistent session).
      gpu: this.gpuLiveRender,
      maxLongEdge,
      qualityPreview,
    };
    // Bracket the full decode (post + worker round-trip) with a performance
    // mark so the browser's Performance panel shows a distinct entry per
    // decode. Name includes id so concurrent decodes don't collide.
    // #1123: `markStart`/`markEnd` — this is diagnostics-only and must never be
    // able to stop `resolve` from running (decodes are serialized behind
    // `decodeChain`, so a stranded `resolve` deadlocks every later decode).
    const decodeStartMark = `maple:decode:${id}:start`;
    markStart(decodeStartMark);
    return new Promise<DecodedImage>((resolve, reject) => {
      this.pending.set(id, {
        kind: 'legacy',
        resolve: (result) => {
          markEnd(decodeStartMark, `maple:decode:${id}:end`, `maple:decode`);
          resolve(result);
        },
        reject,
      });
      worker.postMessage(request, [buffer]);
    });
  }

  /**
   * Decode a RAW byte buffer to a scene-linear Rec.2020 fp16 RGBA image.
   * Pre-AgX, pre-Rec.2020->sRGB — the caller (Plan 3 M3 WebGL2 chain) is
   * expected to apply a view transform before display.
   *
   * Shares the same single-in-flight serialization gate as `decode()` —
   * concurrent calls (across either method) are queued so the WASM heap
   * never holds more than one decode's scratch buffers at once.
   *
   * @param qualityPreview `true` (default) runs the half-res Preview
   *   pipeline (matches Apple's editor first-paint cost). `false` runs
   *   full-res Full — used for export.
   */
  decodeSceneLinear(
    bytes: Uint8Array,
    ext: string,
    xmp?: string,
    qualityPreview: boolean = true,
  ): Promise<DecodedSceneLinearImage> {
    // Non-RAW images bypass rawler: decode browser-natively and convert the
    // sRGB pixels into the scene-linear Rec.2020 fp16 working space the WebGL
    // pipeline consumes. `qualityPreview` is irrelevant — there's no half-res
    // RAW develop to skip.
    if (isNonRawExtension(ext)) {
      return decodeNonRawToSceneLinear(bytes);
    }
    const run = () => this.decodeSceneLinearOnce(bytes, ext, xmp, qualityPreview);
    const next = this.decodeChain.then(run, run);
    this.decodeChain = next.catch(() => undefined);
    return next;
  }

  /**
   * Sized scene-linear decode (#1101, spec §5.1) — the WASM mirror of the
   * Apple FFI's `maple_render_bytes_scene_linear_sized`: same raw-core path,
   * downsampled to fit within `maxLongEdge` immediately after demosaic.
   * Never upscales; the reply carries the native oriented dims. Callers pass
   * `viewportPx × devicePixelRatio` for a viewport-sized working buffer.
   *
   * Same single-in-flight serialization gate as every other decode.
   */
  decodeSceneLinearSized(
    bytes: Uint8Array,
    ext: string,
    maxLongEdge: number,
    xmp?: string,
    qualityPreview: boolean = true,
  ): Promise<DecodedSceneLinearImage> {
    // Non-RAW: browser-native decode at full size (already display-derived
    // pixels; no RAW develop to cap) — mirrors `decodeSized`.
    if (isNonRawExtension(ext)) {
      return decodeNonRawToSceneLinear(bytes);
    }
    const run = () => this.decodeSceneLinearOnce(bytes, ext, xmp, qualityPreview, maxLongEdge);
    const next = this.decodeChain.then(run, run);
    this.decodeChain = next.catch(() => undefined);
    return next;
  }

  private decodeSceneLinearOnce(
    bytes: Uint8Array,
    ext: string,
    xmp: string | undefined,
    qualityPreview: boolean,
    maxLongEdge?: number,
  ): Promise<DecodedSceneLinearImage> {
    let worker: Worker;
    try {
      worker = this.ensureWorker();
    } catch {
      return Promise.reject(new Error('RawPipelineService: worker unavailable'));
    }
    const id = this.nextId++;
    const buffer = bytes.buffer.slice(
      bytes.byteOffset,
      bytes.byteOffset + bytes.byteLength,
    ) as ArrayBuffer;
    const request: DecodeSceneLinearRequest = {
      id,
      type: 'decode-scene-linear',
      bytes: buffer,
      ext,
      xmp,
      qualityPreview,
      maxLongEdge,
    };
    // #1123: markStart/markEnd — see decodeOnce; a throw here must never strand
    // `resolve`.
    const sceneLinearStartMark = `maple:decode-scene-linear:${id}:start`;
    markStart(sceneLinearStartMark);
    return new Promise<DecodedSceneLinearImage>((resolve, reject) => {
      this.pending.set(id, {
        kind: 'scene-linear',
        resolve: (result) => {
          markEnd(
            sceneLinearStartMark,
            `maple:decode-scene-linear:${id}:end`,
            `maple:decode-scene-linear`,
          );
          resolve(result);
        },
        reject,
      });
      worker.postMessage(request, [buffer]);
    });
  }

  // ── Persistent GPU live session (epic #925, P4b-web / #1038) ───────────────
  // The 16ms-ready web live-render path: open a `WebLiveSession` in the worker that
  // keeps the GPU context + uploaded image resident and presents straight to a
  // transferred `OffscreenCanvas` (NO CPU readback). The component routes here only
  // when `gpuLiveRender` is true; otherwise it stays on the `decode()` + 2D-canvas
  // path (flag-off == today, byte-for-byte). Session renders are serialized in the
  // worker (the wasm `&mut self` re-entrancy guard), so concurrent `render()` calls
  // can't trip "recursive use of an object detected".

  /** Whether the GPU live-render path is enabled for this deployment (#1038). */
  get gpuLiveRenderEnabled(): boolean {
    return this.gpuLiveRender;
  }

  /**
   * Open a persistent GPU live session for `bytes`, transferring `canvas` (an
   * `OffscreenCanvas` from `transferControlToOffscreen()`) to the worker. The first
   * frame is presented to the canvas before this resolves. Rejects if the loaded
   * WASM bundle lacks the `gpu` feature (the caller falls back to `decode()`), or on
   * a decode / GPU error. Outside the `decode()` serialization gate — the session
   * lives entirely in the worker and owns its own render queue.
   *
   * The transferred `canvas` is owned by the worker after this call; the caller
   * must not draw to it on the main thread.
   *
   * @param maxLongEdge Viewport target in REAL (backing-store) pixels (#1080):
   *   the session's develop fits the image to this long edge (aspect preserved,
   *   never upscaled) and sizes the canvas to the developed dims. Absent ⇒ the
   *   WASM-side 2048 default cap (the downlevel WebGPU texture baseline). The
   *   reply carries the NATIVE oriented dims in `nativeWidth`/`nativeHeight`.
   */
  openLiveSession(
    canvas: OffscreenCanvas,
    bytes: Uint8Array,
    ext: string,
    xmp?: string,
    maxLongEdge?: number,
  ): Promise<OpenedLiveSession> {
    let worker: Worker;
    try {
      worker = this.ensureWorker();
    } catch {
      return Promise.reject(new Error('RawPipelineService: worker unavailable'));
    }
    const id = this.nextId++;
    // Copy the bytes off the caller's view before transferring (the view stays
    // usable for a later 2D fallback / re-open), mirroring `decodeOnce`.
    const buffer = bytes.buffer.slice(
      bytes.byteOffset,
      bytes.byteOffset + bytes.byteLength,
    ) as ArrayBuffer;
    const request: OpenSessionRequest = {
      id,
      type: 'open-session',
      bytes: buffer,
      ext,
      xmp,
      canvas,
      maxLongEdge,
    };
    return new Promise<OpenedLiveSession>((resolve, reject) => {
      this.pending.set(id, { kind: 'open-session', resolve, reject });
      // Transfer BOTH the byte buffer and the OffscreenCanvas to the worker.
      worker.postMessage(request, [buffer, canvas]);
    });
  }

  /**
   * Re-render the open live session for the develop model serialized in `xmp` and
   * present to the canvas (the #846 edit path). Resolves with the achieved canvas
   * colour-space tag plus an optional downsampled scope readback of the presented
   * frame (#1045). Rejects if no session is open or on a GPU error. The worker
   * serializes these against each other + the open.
   */
  renderLiveSession(xmp?: string, params?: Float32Array): Promise<RenderedLiveSession> {
    let worker: Worker;
    try {
      worker = this.ensureWorker();
    } catch {
      return Promise.reject(new Error('RawPipelineService: worker unavailable'));
    }
    const id = this.nextId++;
    const request: RenderSessionRequest = { id, type: 'render-session', xmp, params };
    return new Promise<RenderedLiveSession>((resolve, reject) => {
      this.pending.set(id, { kind: 'render-session', resolve, reject });
      if (params) {
        worker.postMessage(request, [params.buffer]);
      } else {
        worker.postMessage(request);
      }
    });
  }

  /**
   * Tear down the open live session (asset switch / component destroy). Fire-and-
   * forget — the worker frees the handle behind its render queue (so it never frees
   * while a render holds the borrow). No-op if no worker exists yet.
   */
  closeLiveSession(): void {
    if (!this.worker) return;
    const id = this.nextId++;
    const request: CloseSessionRequest = { id, type: 'close-session' };
    this.worker.postMessage(request);
  }

  // ── Auto-adjust (#1379) ─────────────────────────────────────────────────────
  // One-shot: decode the RAW via the WASM standalone entry and return the 8-field
  // recommendation. Independent of any GPU session — runs on every browser.
  // The worker serialises this behind the same `decodeChain` gate as `decode()` so
  // a concurrent cold-open decode and an AUTO press don't both sit in the WASM heap.

  /**
   * Analyse `bytes` (a RAW file) and return auto-adjustment recommendations.
   *
   * IMPORTANT: the returned `exposure` was measured against an AE-Off probe.
   * The caller MUST set `autoExposure: 'Off'` alongside `exposure` — never
   * apply the result on top of an `auto_exposure: On` model. See the WASM
   * module doc in `raw-wasm/src/auto_adjustments.rs` for the full contract.
   *
   * @param bytes RAW file bytes (copied; the caller's view is not consumed).
   * @param ext   Lowercase file extension, e.g. `"dng"`.
   * @param xmp   Optional current XMP sidecar text. Pass `undefined` for a
   *              fresh-open recommendation (most useful default).
   */
  computeAutoAdjustments(bytes: Uint8Array, ext: string, xmp?: string): Promise<AutoAdjustPatch> {
    const run = () => this.computeAutoAdjustmentsOnce(bytes, ext, xmp);
    const next = this.decodeChain.then(run, run);
    this.decodeChain = next.catch(() => undefined);
    return next;
  }

  private computeAutoAdjustmentsOnce(
    bytes: Uint8Array,
    ext: string,
    xmp: string | undefined,
  ): Promise<AutoAdjustPatch> {
    let worker: Worker;
    try {
      worker = this.ensureWorker();
    } catch {
      return Promise.reject(new Error('RawPipelineService: worker unavailable'));
    }
    const id = this.nextId++;
    // Copy the bytes off the caller's view before transferring (the view stays
    // usable for a later decode / re-open), mirroring `decodeOnce`.
    const buffer = bytes.buffer.slice(
      bytes.byteOffset,
      bytes.byteOffset + bytes.byteLength,
    ) as ArrayBuffer;
    const request: AutoAdjustRequest = { id, type: 'auto-adjust', bytes: buffer, ext, xmp };
    // #1123: markStart/markEnd — see decodeOnce; a throw here must never strand
    // `resolve`.
    const autoAdjustStartMark = `maple:auto-adjust:${id}:start`;
    markStart(autoAdjustStartMark);
    return new Promise<AutoAdjustPatch>((resolve, reject) => {
      this.pending.set(id, {
        kind: 'auto-adjust',
        resolve: (patch) => {
          markEnd(autoAdjustStartMark, `maple:auto-adjust:${id}:end`, 'maple:auto-adjust');
          resolve(patch);
        },
        reject,
      });
      worker.postMessage(request, [buffer]);
    });
  }

  /**
   * Render a RAW at export quality and encode it to a deliverable file (#943).
   *
   * Runs behind the same `decodeChain` gate as `decode()`: a full-resolution
   * export is by far the largest thing the WASM heap ever holds, so it must not
   * overlap another decode competing for the same 4 GiB address space.
   *
   * The reply is a `Blob` — the worker drains the encoded bytes out of the WASM
   * heap in chunks, so neither thread ever holds a second copy of the file.
   */
  exportImage(
    bytes: Uint8Array,
    ext: string,
    options: RawExportOptions,
    xmp?: string,
  ): Promise<ExportedFile> {
    const run = () => this.exportOnce(bytes, ext, options, xmp);
    const next = this.decodeChain.then(run, run);
    this.decodeChain = next.catch(() => undefined);
    return next;
  }

  private exportOnce(
    bytes: Uint8Array,
    ext: string,
    options: RawExportOptions,
    xmp: string | undefined,
  ): Promise<ExportedFile> {
    let worker: Worker;
    try {
      worker = this.ensureWorker();
    } catch {
      return Promise.reject(new Error('RawPipelineService: worker unavailable'));
    }
    const register = (id: number, handler: PendingHandler) => this.pending.set(id, handler);
    return dispatchExport(worker, this.nextId++, register, bytes, ext, options, xmp);
  }

  ngOnDestroy(): void {
    this.worker?.terminate();
    this.worker = null;
    this.pending.forEach(({ reject }) => reject(new Error('RawPipelineService destroyed')));
    this.pending.clear();
  }
}
