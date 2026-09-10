// RawPipelineService — Angular wrapper around the raw-decode Web Worker.
// Lazy-creates the worker on first call, reuses for subsequent calls,
// terminates on app destroy. All decodes run off the main thread.
//
// The worker's thread-pool status protocol outlived the public observables
// #3048 removed; the subjects below still receive those messages.

import { Injectable, Injector, OnDestroy, inject, signal } from '@angular/core';
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
import {
  dispatchImportLensProfile,
  restoreRequestedLensProfile,
} from './raw-pipeline.lens-profile-request';
import type { ImportedLensProfile, LensProfileStatus } from '../lens/lens-profile.types';
import { LIBRARY_BACKEND } from '../api/library-backend.token';
import type { SampleQueue } from './raw-pipeline.samplers';
import {
  sampleMaskRange as runMaskRangeSample,
  sampleWhiteBalance as runWhiteBalanceSample,
} from './raw-pipeline.samplers';
import type { WbSampleResult } from './raw-pipeline.sample-wb.types';
import type { MaskRangeSeed } from './raw-pipeline.sample-range.types';
import { dispatchWithMark } from './raw-pipeline.dispatch-with-mark';
import { developNonRaw } from './raw-pipeline.non-raw-develop';
import {
  dispatchRegisterMaskRaster,
  releaseMaskRasterRequest,
} from './raw-pipeline.mask-raster-request';
import type { MaskRasterUpload } from './raw-pipeline.mask-raster.types';
import {
  openLiveSessionRequest,
  renderLiveSessionRequest,
  closeLiveSessionRequest,
} from './raw-pipeline.gpu-live-session';

export type { AutoAdjustPatch } from './raw-pipeline.types';
import { GpuLiveRenderGate } from './gpu-live-render.gate';
import { CanvasColorSpacePref } from './canvas-color-space.pref';
import { isNonRawExtension } from '../state/raw-extensions';
import { NativeDetailClient } from './raw-pipeline.native-detail';
import type { NativeDetailArgs, NativeDetailPixels } from './raw-pipeline.native-detail.types';
import type {
  OpenedLiveSession,
  PendingHandler,
  RenderedLiveSession,
} from './raw-pipeline.service-internals';
export type { OpenedLiveSession, RenderedLiveSession } from './raw-pipeline.service-internals';
import { handleWorkerMessage } from './raw-pipeline.worker-dispatch';

@Injectable({ providedIn: 'root' })
export class RawPipelineService implements OnDestroy {
  // Routes the legacy `decode()` through the GPU live chain when true (#1029);
  // the worker still falls back to `render_bytes` on a gpu-off bundle. Read
  // at REQUEST time (#1062) so an operator flip lands on the next open.
  private readonly gate = inject(GpuLiveRenderGate);

  // #3191: the requested GPU-live canvas colour space, read per session-open
  // request (same pattern as `gate` above) so a Settings change lands on the
  // next image open with no reload.
  private readonly colorSpacePref = inject(CanvasColorSpacePref);

  // #3479: Self Hosted restores a missing browser copy of an imported lens
  // profile from the server cache; the bridge is reached lazily through the
  // injector so Hosted never bundles the authenticated client.
  private readonly injector = inject(Injector);
  private readonly backend = inject(LIBRARY_BACKEND);

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

  /** Real BM3D progress from worker broadcasts (#1153), cleared when the
   * develop request settles because the stage has no final completion tick. */
  readonly deepDenoiseProgress = signal<{ pass: 1 | 2; fraction: number } | null>(null);

  /**
   * #3397: most recent downsampled readback of the presented frame, or `null`
   * before the first sample. Fed by the worker's `scope-sample` broadcast
   * rather than the render reply, keeping that GPU sync off the path the
   * latest-wins scheduler waits on. Latest-wins and lossy by design.
   */
  readonly scopeSample = signal<DecodedImage | null>(null);

  /**
   * #3479: whether the imported lens profile the latest render named could be
   * supplied from the browser / server caches. `available: false` is what the
   * Lens Corrections panel shows as an explicit error; raw-core refuses the
   * render itself when the profile was required.
   */
  readonly lensProfileStatus = signal<LensProfileStatus | null>(null);

  private ensureWorker(): Worker {
    if (this.worker) return this.worker;
    try {
      this.worker = new Worker(new URL('./raw-pipeline.worker', import.meta.url), {
        type: 'module',
      });
      const worker = this.worker;
      this.worker.addEventListener('message', (e: MessageEvent<WorkerResponse>) => {
        if (e.data.type === 'export-error' && e.data.fatal) {
          this.retireWorker(worker, e.data.message);
          return;
        }
        // Routing lives in `raw-pipeline.worker-dispatch.ts` (#2314) — this
        // file kept every response kind's handling inline until it grew past
        // the file-size budget. Pure code move: no behaviour change.
        handleWorkerMessage(e.data, {
          pending: this.pending,
          threadedSubject: this.threadedSubject,
          threadCountSubject: this.threadCountSubject,
          deepDenoiseProgress: this.deepDenoiseProgress,
          scopeSample: this.scopeSample,
          lensProfileStatus: this.lensProfileStatus,
          restoreLensProfile: (request) =>
            restoreRequestedLensProfile(
              worker,
              request,
              this.injector,
              this.backend === 'self-hosted',
            ),
        });
      });
      this.worker.addEventListener('error', (e) => {
        console.error('RawPipelineWorker error:', e.message);
        this.retireWorker(worker, `Worker error: ${e.message}`);
      });
    } catch (err) {
      console.error('Failed to create RawPipelineWorker:', err);
      throw err;
    }
    return this.worker;
  }

  private retireWorker(worker: Worker, message: string): void {
    worker.terminate();
    if (this.worker !== worker) return;
    this.deepDenoiseProgress.set(null);
    this.detailClient.workerFailed();
    this.pending.forEach(({ reject }) => reject(new Error(message)));
    this.pending.clear();
    this.worker = null;
  }

  // Serialization gate: the worker's `message` handler is async, so multiple
  // concurrent decode requests would be in-flight at once and each one holds
  // hundreds of MB of zero-initialized f32 scratch buffers in WASM memory.
  // Two large decodes running together blow past the 4 GiB wasm32 cap and
  // abort with `RuntimeError: unreachable`. Queue them here so exactly one
  // decode sits in the worker at any moment.
  private decodeChain: Promise<unknown> = Promise.resolve();
  private readonly detailClient = new NativeDetailClient(
    () => this.ensureWorker(),
    () => this.nextId++,
    this.pending,
  );

  // Called through NativeDetailHost's Pick<RawPipelineService, ...> boundary.
  // fallow-ignore-next-line unused-class-member
  renderNativeDetail(args: NativeDetailArgs): Promise<NativeDetailPixels> {
    const revision = this.detailClient.revision();
    const run = () => this.detailClient.render(args, revision);
    const next = this.decodeChain.then(run, run);
    this.decodeChain = next.catch(() => undefined);
    return next;
  }

  closeNativeDetail(): void {
    this.detailClient.close();
  }

  /**
   * @param maxLongEdge Cap the long edge in REAL pixels (#1101): routes the
   *   sized WASM-CPU entry, which downsamples right after demosaic. Never
   *   upscales; the reply carries the NATIVE dims. Absent ⇒ full-res.
   * @param qualityPreview Only with `maxLongEdge`: half-res Preview demosaic
   *   (fast phase) vs Full (refine).
   * @param filmLut A resolved `.mlut` grid (#3171), routed per
   *   `selectLegacyDecodeRoute`. NOT transferred: the same buffer is reused
   *   across every fast/refine tick until the look changes.
   *
   * Non-RAW images decode browser-natively at full size (sizing ignored) and
   * still run the WASM adjustment chain via `develop_non_raw` (#3039).
   */
  decode(
    bytes: Uint8Array,
    ext: string,
    xmp?: string,
    maxLongEdge?: number,
    qualityPreview?: boolean,
    filmLut?: ArrayBuffer,
  ): Promise<DecodedImage> {
    // Non-RAW images never touch demosaic but DO run the per-tick adjustment
    // chain (#3039, mirroring Apple's `processSceneLinearNonRaw`), so they
    // join the serialization gate and cross into the worker like a RAW.
    this.closeNativeDetail();
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
  // A worker-resident `WebLiveSession` presents straight to a transferred
  // `OffscreenCanvas` (no readback). Outside the `decode()` gate — the worker
  // serializes session ops itself. Bodies live in `raw-pipeline.gpu-live-session.ts`.
  // Reached via `this.host.pipeline.<method>` on the `GpuPresentHost` interface,
  // which fallow's dead-code pass can't trace — hence the suppression on each.

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
   * Load (or clear) the open live session's film-look LUT (epic #2683):
   * `bytes` is a `.mlut` v1 buffer (empty clears), `lookKey` its content
   * identity. Takes effect on the caller's next `renderLiveSession`.
   * Reached via `FilmSyncHost.pipeline` (image-canvas.film.ts), untraceable
   * for fallow's dead-code pass.
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

  /** Register a `bitmap` mask's R8 raster under its recipe digest (#3300 — the web
   *  mirror of raw-ffi's `maple_mask_raster_register`); resolves with the raster id.
   *  Contract in `raw-pipeline.mask-raster.types.ts`. No caller yet: the web has no
   *  segmentation source (#3300 slice 3), which is what will drive this half. */
  // fallow-ignore-next-line unused-class-member
  registerMaskRaster(raster: MaskRasterUpload): Promise<number> {
    let worker: Worker;
    try {
      worker = this.ensureWorker();
    } catch {
      return Promise.reject(new Error('RawPipelineService: worker unavailable'));
    }
    const register = this.pending.set.bind(this.pending);
    return dispatchRegisterMaskRaster(worker, this.nextId++, register, raster);
  }

  /** Forget a raster registered by `registerMaskRaster`. Fire-and-forget. */
  // fallow-ignore-next-line unused-class-member
  releaseMaskRaster(rasterId: number): void {
    if (!this.worker) return;
    releaseMaskRasterRequest(this.worker, this.nextId++, rasterId);
  }

  /**
   * Import a user-owned `.lcp` document for the RAW in `bytes` (#3479): the
   * worker registers it, resolves it against that RAW, persists the bytes
   * in IndexedDB and reports the inventory + resolution. Behind the
   * `decodeChain` gate — the resolve decodes the RAW in the worker.
   */
  importLensProfile(xml: string, bytes: Uint8Array, ext: string): Promise<ImportedLensProfile> {
    return this.sampleQueue((worker, id, register) =>
      dispatchImportLensProfile(worker, id, register, xml, bytes, ext),
    );
  }

  // ── Auto-adjust (#1379) ─────────────────────────────────────────────────────
  /**
   * Analyse a RAW and return the 8-field auto-adjustment recommendation —
   * a standalone WASM probe, independent of any GPU session, behind the
   * same `decodeChain` gate as `decode()`. IMPORTANT: `exposure` was
   * measured against an AE-Off probe, so the caller MUST set
   * `autoExposure: 'Off'` alongside it (`raw-wasm/src/auto_adjustments.rs`).
   * `xmp` undefined ⇒ a fresh-open recommendation.
   */
  computeAutoAdjustments(bytes: Uint8Array, ext: string, xmp?: string): Promise<AutoAdjustPatch> {
    return this.sampleQueue((worker, id, register) =>
      dispatchAutoAdjust(worker, id, register, bytes, ext, xmp),
    );
  }

  // ── Cold one-shot samplers (#2434 white balance, #362 mask colour range) ────
  // Bodies live in `raw-pipeline.samplers.ts` (this file is at its size
  // budget); both run behind `decodeChain` via `sampleQueue` below.

  // fallow-ignore-next-line unused-class-member
  sampleWhiteBalance(
    bytes: Uint8Array,
    ext: string,
    xmp: string | undefined,
    nx: number,
    ny: number,
  ): Promise<WbSampleResult> {
    return runWhiteBalanceSample(this.sampleQueue, bytes, ext, xmp, nx, ny);
  }

  // fallow-ignore-next-line unused-class-member
  sampleMaskRange(
    bytes: Uint8Array,
    ext: string,
    xmp: string | undefined,
    nx: number,
    ny: number,
  ): Promise<MaskRangeSeed> {
    return runMaskRangeSample(this.sampleQueue, bytes, ext, xmp, nx, ny);
  }

  /** Chains one request after the in-flight decode work: every sampler, the
   *  AUTO probe and a lens-profile import develop their own decode, so two
   *  must never sit in the WASM heap at once. */
  private readonly sampleQueue: SampleQueue = (run) => {
    const once = () => {
      try {
        return run(this.ensureWorker(), this.nextId++, this.pending.set.bind(this.pending));
      } catch {
        return Promise.reject(new Error('RawPipelineService: worker unavailable'));
      }
    };
    const next = this.decodeChain.then(once, once);
    this.decodeChain = next.catch(() => undefined);
    return next;
  };

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
    const run = () => {
      // Export decodes its own sensor data. Release the detail viewer's cached
      // mosaic first so a large export does not retain two full RAW decodes.
      this.closeNativeDetail();
      return this.exportOnce(bytes, ext, options, xmp, filmLut);
    };
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
