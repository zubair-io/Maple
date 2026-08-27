// RawPipelineService — Angular wrapper around the raw-decode Web Worker.
// Lazy-creates the worker on first call, reuses for subsequent calls,
// terminates on app destroy. All decodes run off the main thread.
//
// T10: exposes `isThreaded$` (Observable<boolean>) so UI can surface the actual
// runtime mode. Hosts without COOP+COEP are serial; Chromium-family runtimes are
// also serial while #2515 is mitigated (#2516 tracks safe Rayon restoration).
// The observable starts undefined and emits once WASM init reports back.

import { Injectable, OnDestroy, inject, signal } from '@angular/core';
import { BehaviorSubject, Observable } from 'rxjs';
import type {
  AutoAdjustPatch,
  DecodedImage,
  DecodedSceneLinearImage,
  DecodeRequest,
  DecodeSceneLinearRequest,
  SetFilmLutRequest,
  ExportedFile,
  RawExportOptions,
  WorkerResponse,
} from './raw-pipeline.types';
import { dispatchExport } from './raw-pipeline.export-request';
import { dispatchAutoAdjust } from './raw-pipeline.auto-adjust-request';
import { dispatchWithMark } from './raw-pipeline.dispatch-with-mark';
import { developNonRaw } from './raw-pipeline.non-raw-develop';
import {
  openLiveSessionRequest,
  renderLiveSessionRequest,
  closeLiveSessionRequest,
} from './raw-pipeline.gpu-live-session';

export type { AutoAdjustPatch } from './raw-pipeline.types';
import { GpuLiveRenderGate } from './gpu-live-render.gate';
import { isNonRawExtension } from '../state/raw-extensions';
import { decodeNonRawToSceneLinear } from './image-utils';
import type {
  OpenedLiveSession,
  PendingHandler,
  RenderedLiveSession,
} from './raw-pipeline.service-internals';
export type { OpenedLiveSession, RenderedLiveSession } from './raw-pipeline.service-internals';
import { handleWorkerMessage } from './raw-pipeline.worker-dispatch';

@Injectable({ providedIn: 'root' })
export class RawPipelineService implements OnDestroy {
  // Routes the legacy display-encoded `decode()` through the GPU live chain
  // (`render_bytes_gpu`) when true (epic #925, P4b-web / #1029). Off → the
  // WASM-CPU `render_bytes` path, byte-for-byte today. The worker further
  // gates on whether the loaded bundle exports the GPU entry, so flag-on
  // against a gpu-off WASM build still falls back to `render_bytes`.
  //
  // #1062: read from `GpuLiveRenderGate` (build-time token AND the DB-backed
  // operator setting) at REQUEST time rather than captured at construction, so
  // an operator kill lands on the next decode / live-session open instead of
  // needing a reload.
  private readonly gate = inject(GpuLiveRenderGate);

  private worker: Worker | null = null;
  private nextId = 1;
  private pending = new Map<number, PendingHandler>();

  // T10: threaded-state signal. `null` = not yet reported by the worker.
  private readonly threadedSubject = new BehaviorSubject<boolean | null>(null);
  private readonly threadCountSubject = new BehaviorSubject<number>(1);

  /**
   * Emits once the Web Worker has initialised the WASM thread pool.
   *
   * No production caller remains anywhere in the app (T10 threaded-state UI
   * surface was never wired up past this point) — vestigial, not fixed here;
   * out of scope for the #3039 single-file non-RAW render fix that touched
   * this file. Tracked as a follow-up cleanup.
   */
  // fallow-ignore-next-line unused-class-member
  readonly isThreaded$: Observable<boolean | null> = this.threadedSubject.asObservable();

  /**
   * Emits the number of rayon worker threads (1 when single-threaded).
   *
   * Same T10 vestigial surface as `isThreaded$` above — see its doc.
   */
  // fallow-ignore-next-line unused-class-member
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
        // Routing lives in `raw-pipeline.worker-dispatch.ts` (#2314) — this
        // file kept every response kind's handling inline until it grew past
        // the file-size budget. Pure code move: no behaviour change.
        handleWorkerMessage(e.data, {
          pending: this.pending,
          threadedSubject: this.threadedSubject,
          threadCountSubject: this.threadCountSubject,
          deepDenoiseProgress: this.deepDenoiseProgress,
        });
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
   *   for the fast phase. Routes the WASM-CPU sized entry
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
   * Non-RAW images decode browser-natively at their full size (sizing them
   * is the canvas's draw transform's job — `maxLongEdge`/`qualityPreview`
   * are ignored for this branch), but DO still run through the WASM
   * per-tick adjustment chain via `develop_non_raw` (#3039) — see
   * `raw-pipeline.non-raw-develop.ts`'s `developNonRaw`.
   */
  decode(
    bytes: Uint8Array,
    ext: string,
    xmp?: string,
    maxLongEdge?: number,
    qualityPreview?: boolean,
  ): Promise<DecodedImage> {
    // Non-RAW images (jpg/png/heic/webp/…) are already developed sRGB pixels,
    // so they never touch `rawler`/demosaic — but they DO still need the
    // per-tick adjustment chain applied on every call (#3039): a JPEG opened
    // in the single-file editor is editable exactly like a RAW, and Apple's
    // `ImageEditPipeline.processSceneLinearNonRaw` already runs the SAME
    // adjustment chain here (via the C-FFI `apply_scene_linear_chain`,
    // AgX skipped). `developNonRaw` decodes browser-natively (mirroring
    // Apple's ImageIO path) and then runs that chain through the WASM
    // `develop_non_raw` entry — so this DOES join the serialization gate and
    // DOES cross into the worker, unlike the pre-#3039 version of this
    // comment, which decoded once and never touched WASM again.
    const run = isNonRawExtension(ext)
      ? () =>
          developNonRaw(
            bytes,
            xmp,
            () => this.ensureWorker(),
            () => this.nextId++,
            this.pending.set.bind(this.pending),
          )
      : () => this.decodeOnce(bytes, ext, xmp, maxLongEdge, qualityPreview);
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
      gpu: this.gpuLiveRenderEnabled,
      maxLongEdge,
      qualityPreview,
    };
    return dispatchWithMark<DecodedImage>(
      worker,
      request,
      [buffer],
      'maple:decode',
      ({ resolve, reject }) => ({ kind: 'legacy', resolve, reject }),
      this.pending.set.bind(this.pending),
    );
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
   *
   * Vestigial Plan 3 M1/M3 WebGL2 scene-linear surface: no production caller
   * remains anywhere in the app (the shipping GPU live path is the wgpu/WGSL
   * chain, epic #925 — see this file's `openLiveSession`/`renderLiveSession`
   * below, not this method). Kept, not deleted, pending a decision on
   * whether to retire it outright; out of scope for the #3039 single-file
   * non-RAW render fix that touched this file. Tracked as a follow-up
   * cleanup, not fixed here to avoid unrelated risk in that PR.
   */
  // fallow-ignore-next-line unused-class-member
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
   *
   * Vestigial Plan 3 M1/M3 WebGL2 scene-linear surface — see
   * `decodeSceneLinear`'s doc above for why this is suppressed rather than
   * deleted or fixed here.
   */
  // fallow-ignore-next-line unused-class-member
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
    return dispatchWithMark<DecodedSceneLinearImage>(
      worker,
      request,
      [buffer],
      'maple:decode-scene-linear',
      ({ resolve, reject }) => ({ kind: 'scene-linear', resolve, reject }),
      this.pending.set.bind(this.pending),
    );
  }

  // ── Persistent GPU live session (epic #925, P4b-web / #1038) ───────────────
  // The 16ms-ready web live-render path: open a `WebLiveSession` in the worker that
  // keeps the GPU context + uploaded image resident and presents straight to a
  // transferred `OffscreenCanvas` (NO CPU readback). The component routes here only
  // when `gpuLiveRender` is true; otherwise it stays on the `decode()` + 2D-canvas
  // path (flag-off == today, byte-for-byte). Session renders are serialized in the
  // worker (the wasm `&mut self` re-entrancy guard), so concurrent `render()` calls
  // can't trip "recursive use of an object detected". Outside the `decode()`
  // serialization gate — the session lives entirely in the worker and owns its own
  // render queue. Request bodies live in `raw-pipeline.gpu-live-session.ts`
  // (file-budget split, mirrors `raw-pipeline.non-raw-develop.ts`); these three
  // methods keep ownership of `ensureWorker()`'s try/catch and just delegate.
  //
  // Called via `this.host.pipeline.<method>(...)` in `ImageCanvasGpuPresent`
  // (image-canvas.gpu-present.ts), where `pipeline` is a type-only-imported
  // `RawPipelineService` field on the `GpuPresentHost` interface; fallow's
  // dead-code pass doesn't trace calls through that indirection (same blind
  // spot `setFilmLut` below documents) — hence the suppression on each.

  /** Whether the GPU live-render path is enabled right now (#1038, #1062):
   * the build-time token AND the operator's DB-backed setting. Evaluated per
   * call, so a runtime flip is picked up by the next image open. */
  get gpuLiveRenderEnabled(): boolean {
    return this.gate.enabled();
  }

  // fallow-ignore-next-line unused-class-member
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
    return openLiveSessionRequest(
      worker,
      this.nextId++,
      this.pending.set.bind(this.pending),
      canvas,
      bytes,
      ext,
      xmp,
      maxLongEdge,
    );
  }

  // fallow-ignore-next-line unused-class-member
  renderLiveSession(xmp?: string, params?: Float32Array): Promise<RenderedLiveSession> {
    let worker: Worker;
    try {
      worker = this.ensureWorker();
    } catch {
      return Promise.reject(new Error('RawPipelineService: worker unavailable'));
    }
    return renderLiveSessionRequest(
      worker,
      this.nextId++,
      this.pending.set.bind(this.pending),
      xmp,
      params,
    );
  }

  // fallow-ignore-next-line unused-class-member
  closeLiveSession(): void {
    if (!this.worker) return;
    closeLiveSessionRequest(this.worker, this.nextId++);
  }

  /**
   * Load (or clear) the open live session's film-look LUT (epic #2683, Task
   * 12 — client half of Task 9's `set-film-lut` worker protocol). `bytes` is
   * a `.mlut` v1 buffer, transferred like `openLiveSession`'s bytes; an
   * empty buffer clears the loaded look (the Film panel's "None" row).
   * `lookKey` is the `FilmLutService.filmLutKey`-derived content-identity
   * key for the loaded look. Does NOT itself trigger a re-render — the
   * caller's next `renderLiveSession` call picks up the new grid.
   *
   * Called via `this.host.pipeline.setFilmLut(...)` in ImageCanvasFilmSync
   * (image-canvas.film.ts), where `pipeline` is a type-only-imported
   * `RawPipelineService` field on the `FilmSyncHost` interface; fallow's
   * dead-code pass doesn't trace calls through that indirection.
   */
  // fallow-ignore-next-line unused-class-member
  setFilmLut(bytes: ArrayBuffer, lookKey: number): Promise<void> {
    let worker: Worker;
    try {
      worker = this.ensureWorker();
    } catch {
      return Promise.reject(new Error('RawPipelineService: worker unavailable'));
    }
    const id = this.nextId++;
    const request: SetFilmLutRequest = { id, type: 'set-film-lut', bytes, lookKey };
    return new Promise<void>((resolve, reject) => {
      this.pending.set(id, { kind: 'set-film-lut', resolve, reject });
      worker.postMessage(request, [bytes]);
    });
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
    return dispatchAutoAdjust(
      worker,
      this.nextId++,
      this.pending.set.bind(this.pending),
      bytes,
      ext,
      xmp,
    );
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
    filmLut?: ArrayBuffer,
  ): Promise<ExportedFile> {
    const run = () => this.exportOnce(bytes, ext, options, xmp, filmLut);
    const next = this.decodeChain.then(run, run);
    this.decodeChain = next.catch(() => undefined);
    return next;
  }

  private exportOnce(
    bytes: Uint8Array,
    ext: string,
    options: RawExportOptions,
    xmp: string | undefined,
    filmLut: ArrayBuffer | undefined,
  ): Promise<ExportedFile> {
    let worker: Worker;
    try {
      worker = this.ensureWorker();
    } catch {
      return Promise.reject(new Error('RawPipelineService: worker unavailable'));
    }
    const register = (id: number, handler: PendingHandler) => this.pending.set(id, handler);
    return dispatchExport(worker, this.nextId++, register, bytes, ext, options, xmp, filmLut);
  }

  ngOnDestroy(): void {
    this.worker?.terminate();
    this.worker = null;
    this.pending.forEach(({ reject }) => reject(new Error('RawPipelineService destroyed')));
    this.pending.clear();
  }
}
