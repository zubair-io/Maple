// RawPipelineService — Angular wrapper around the raw-decode Web Worker.
// Lazy-creates the worker on first call, reuses for subsequent calls,
// terminates on app destroy. All decodes run off the main thread.
//
// T10: the worker still reports its thread-pool status (`threadedSubject`/
// `threadCountSubject` below) once WASM init completes — but the public
// `isThreaded$`/`threadCount$` observables that surfaced this to a UI were
// removed as dead (#3048): no production caller remained anywhere in the
// app. Retiring the worker-side status message and its request/response
// protocol is a further, separate cleanup (touches raw-pipeline.worker.ts
// and raw-pipeline.types.ts, outside this ticket's scope) — flagged as a
// follow-up rather than folded in here.

import { Injectable, OnDestroy, inject, signal } from '@angular/core';
import { BehaviorSubject } from 'rxjs';
import type {
  AutoAdjustPatch,
  DecodedImage,
  DecodeRequest,
  SetFilmLutRequest,
  ExportedFile,
  RawExportOptions,
  WorkerResponse,
} from './raw-pipeline.types';
import { dispatchExport } from './raw-pipeline.export-request';
import { dispatchAutoAdjust } from './raw-pipeline.auto-adjust-request';
import { dispatchSampleWb } from './raw-pipeline.sample-wb-request';
import type { WbSampleResult } from './raw-pipeline.sample-wb.types';
import { dispatchWithMark } from './raw-pipeline.dispatch-with-mark';
import { developNonRaw } from './raw-pipeline.non-raw-develop';
import {
  openLiveSessionRequest,
  renderLiveSessionRequest,
  closeLiveSessionRequest,
} from './raw-pipeline.gpu-live-session';

export type { AutoAdjustPatch } from './raw-pipeline.types';
import { GpuLiveRenderGate } from './gpu-live-render.gate';
import { CanvasColorSpacePref } from './canvas-color-space.pref';
import { isNonRawExtension } from '../state/raw-extensions';
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

  // #3191: the requested GPU-live canvas colour space, read per session-open
  // request (same pattern as `gate` above) so a Settings change lands on the
  // next image open with no reload.
  private readonly colorSpacePref = inject(CanvasColorSpacePref);

  private worker: Worker | null = null;
  private nextId = 1;
  private pending = new Map<number, PendingHandler>();

  // T10: threaded-state, reported by the worker once WASM init completes.
  // `isThreaded$`/`threadCount$`, the observables that used to surface this
  // to a UI, were deleted as dead (#3048 — no production caller remained).
  // The subjects themselves stay: `raw-pipeline.worker-dispatch.ts`'s shared
  // `WorkerDispatchContext` still populates them from the worker's `status`
  // message, and retiring that protocol end-to-end is a separate follow-up
  // (see the module doc above).
  private readonly threadedSubject = new BehaviorSubject<boolean | null>(null);
  private readonly threadCountSubject = new BehaviorSubject<number>(1);

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
   * @param filmLut A resolved film-look `.mlut` v1 grid (#3171) — the
   *   WASM-CPU counterpart of the GPU live session's `set-film-lut` upload
   *   (see `setFilmLut` below and `ImageCanvasFilmSync`). Absent/empty
   *   renders with no look applied. Routes to `sizedFilm`/`film` per
   *   `selectLegacyDecodeRoute` (`raw-pipeline.decode-route.ts`) —
   *   `decodeOnce` does not need to know which. Deliberately NOT part of
   *   `decodeOnce`'s transfer list: unlike `bytes` (a one-shot RAW file
   *   copy), the SAME resolved LUT buffer is reused across every
   *   fast/refine render tick until the look changes, and transferring it
   *   would detach/neuter it after the first tick.
   */
  decode(
    bytes: Uint8Array,
    ext: string,
    xmp?: string,
    maxLongEdge?: number,
    qualityPreview?: boolean,
    filmLut?: ArrayBuffer,
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
      : () => this.decodeOnce(bytes, ext, xmp, maxLongEdge, qualityPreview, filmLut);
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
    filmLut?: ArrayBuffer,
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
      filmLut,
    };
    return dispatchWithMark<DecodedImage>(
      worker,
      request,
      // `filmLut` is deliberately absent from the transfer list — see
      // `decode()`'s doc. Structured-cloning a `.mlut` grid (tens of KB) is
      // negligible next to the RAW `bytes` transfer this call already makes.
      [buffer],
      'maple:decode',
      ({ resolve, reject }) => ({ kind: 'legacy', resolve, reject }),
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
      this.colorSpacePref.current(),
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

  // ── Neutral white-balance sampler (#2434) ───────────────────────────────────

  /**
   * Sample the neutral at a normalised image-relative point and return the
   * slider pair that renders that surface neutral, plus the version of the
   * derivation (`wb_algorithm_version`).
   *
   * Rejects with a `WbSampleRejected` carrying the reason the click was not
   * usable (clipped, too dark, outside the image, outside the slider domain)
   * so the caller can phrase an actionable message rather than a generic
   * failure. Shares `decodeChain` with `decode()` and the auto-adjust
   * one-shot: the sampler decodes and develops the same probe AUTO does, so
   * two of them must not sit in the WASM heap at once.
   *
   * @param bytes RAW file bytes (copied; the caller's view is not consumed).
   * @param ext   Lowercase file extension, e.g. `"dng"`.
   * @param xmp   Current XMP sidecar text, or `undefined` for a fresh open.
   * @param nx    Normalised x, `0` = left edge, `1` = right edge.
   * @param ny    Normalised y, `0` = top edge, `1` = bottom edge.
   */
  // fallow-ignore-next-line unused-class-member
  sampleWhiteBalance(
    bytes: Uint8Array,
    ext: string,
    xmp: string | undefined,
    nx: number,
    ny: number,
  ): Promise<WbSampleResult> {
    const run = () => this.sampleWhiteBalanceOnce(bytes, ext, xmp, nx, ny);
    const next = this.decodeChain.then(run, run);
    this.decodeChain = next.catch(() => undefined);
    return next;
  }

  private sampleWhiteBalanceOnce(
    bytes: Uint8Array,
    ext: string,
    xmp: string | undefined,
    nx: number,
    ny: number,
  ): Promise<WbSampleResult> {
    try {
      return dispatchSampleWb(
        this.ensureWorker(),
        this.nextId++,
        this.pending.set.bind(this.pending),
        bytes,
        ext,
        xmp,
        nx,
        ny,
      );
    } catch {
      return Promise.reject(new Error('RawPipelineService: worker unavailable'));
    }
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
