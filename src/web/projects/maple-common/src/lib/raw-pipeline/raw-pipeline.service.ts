// RawPipelineService — Angular wrapper around the raw-decode Web Worker.
// Lazy-creates the worker on first call, reuses for subsequent calls,
// terminates on app destroy. All decodes run off the main thread.
//
// T10: exposes `isThreaded$` (Observable<boolean>) so UI can surface a
// "single-threaded mode" indicator on browsers without cross-origin isolation
// (Safari / Firefox default, or any host without COOP+COEP). The observable
// starts undefined and emits once the worker's WASM init reports back.

import { Injectable, OnDestroy } from '@angular/core';
import { BehaviorSubject, Observable } from 'rxjs';
import type {
  DecodedImage,
  DecodedSceneLinearImage,
  DecodeRequest,
  DecodeSceneLinearRequest,
  WorkerResponse,
} from './raw-pipeline.types';

@Injectable({ providedIn: 'root' })
export class RawPipelineService implements OnDestroy {
  private worker: Worker | null = null;
  private nextId = 1;
  private pending = new Map<
    number,
    | {
        kind: 'legacy';
        resolve: (img: DecodedImage) => void;
        reject: (err: Error) => void;
      }
    | {
        kind: 'scene-linear';
        resolve: (img: DecodedSceneLinearImage) => void;
        reject: (err: Error) => void;
      }
  >();

  // T10: threaded-state signal. `null` = not yet reported by the worker.
  private readonly threadedSubject = new BehaviorSubject<boolean | null>(null);
  private readonly threadCountSubject = new BehaviorSubject<number>(1);

  /** Emits once the Web Worker has initialised the WASM thread pool. */
  readonly isThreaded$: Observable<boolean | null> =
    this.threadedSubject.asObservable();

  /** Emits the number of rayon worker threads (1 when single-threaded). */
  readonly threadCount$: Observable<number> =
    this.threadCountSubject.asObservable();

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
        const handler = this.pending.get(msg.id);
        if (!handler) return;
        this.pending.delete(msg.id);
        if (msg.type === 'decode-success' && handler.kind === 'legacy') {
          handler.resolve({
            width: msg.width,
            height: msg.height,
            rgb: new Uint8Array(msg.rgb),
            asShotTemperature: msg.asShotTemperature,
            asShotTint: msg.asShotTint,
          });
        } else if (msg.type === 'decode-error' && handler.kind === 'legacy') {
          handler.reject(new Error(msg.message));
        } else if (
          msg.type === 'decode-scene-linear-success' &&
          handler.kind === 'scene-linear'
        ) {
          handler.resolve({
            width: msg.width,
            height: msg.height,
            fp16Rgba: new Uint16Array(msg.fp16Rgba),
            asShotTemperature: msg.asShotTemperature,
            asShotTint: msg.asShotTint,
          });
        } else if (
          msg.type === 'decode-scene-linear-error' &&
          handler.kind === 'scene-linear'
        ) {
          handler.reject(new Error(msg.message));
        } else {
          // Mismatched response type and handler kind — should never happen
          // because ids are unique and the worker only emits success/error
          // matching the request type. Reject defensively to avoid hangs.
          handler.reject(
            new Error(`raw-pipeline: handler kind mismatch (${msg.type})`),
          );
        }
      });
      this.worker.addEventListener('error', (e) => {
        console.error('RawPipelineWorker error:', e.message);
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

  decode(bytes: Uint8Array, ext: string, xmp?: string): Promise<DecodedImage> {
    const run = () => this.decodeOnce(bytes, ext, xmp);
    const next = this.decodeChain.then(run, run);
    // Preserve the chain regardless of success/failure so one bad decode
    // doesn't stall the queue.
    this.decodeChain = next.catch(() => undefined);
    return next;
  }

  private decodeOnce(bytes: Uint8Array, ext: string, xmp?: string): Promise<DecodedImage> {
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
    const request: DecodeRequest = { id, type: 'decode', bytes: buffer, ext, xmp };
    // Bracket the full decode (post + worker round-trip) with a performance
    // mark so the browser's Performance panel shows a distinct entry per
    // decode. Name includes id so concurrent decodes don't collide.
    performance.mark(`maple:decode:${id}:start`);
    return new Promise<DecodedImage>((resolve, reject) => {
      this.pending.set(id, {
        kind: 'legacy',
        resolve: (result) => {
          performance.mark(`maple:decode:${id}:end`);
          performance.measure(
            `maple:decode`,
            `maple:decode:${id}:start`,
            `maple:decode:${id}:end`,
          );
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
    const run = () => this.decodeSceneLinearOnce(bytes, ext, xmp, qualityPreview);
    const next = this.decodeChain.then(run, run);
    this.decodeChain = next.catch(() => undefined);
    return next;
  }

  private decodeSceneLinearOnce(
    bytes: Uint8Array,
    ext: string,
    xmp: string | undefined,
    qualityPreview: boolean,
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
    };
    performance.mark(`maple:decode-scene-linear:${id}:start`);
    return new Promise<DecodedSceneLinearImage>((resolve, reject) => {
      this.pending.set(id, {
        kind: 'scene-linear',
        resolve: (result) => {
          performance.mark(`maple:decode-scene-linear:${id}:end`);
          performance.measure(
            `maple:decode-scene-linear`,
            `maple:decode-scene-linear:${id}:start`,
            `maple:decode-scene-linear:${id}:end`,
          );
          resolve(result);
        },
        reject,
      });
      worker.postMessage(request, [buffer]);
    });
  }

  ngOnDestroy(): void {
    this.worker?.terminate();
    this.worker = null;
    this.pending.forEach(({ reject }) => reject(new Error('RawPipelineService destroyed')));
    this.pending.clear();
  }
}
