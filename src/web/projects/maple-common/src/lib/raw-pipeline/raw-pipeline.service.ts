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
  DecodeRequest,
  WorkerResponse,
} from './raw-pipeline.types';

@Injectable({ providedIn: 'root' })
export class RawPipelineService implements OnDestroy {
  private worker: Worker | null = null;
  private nextId = 1;
  private pending = new Map<
    number,
    {
      resolve: (img: DecodedImage) => void;
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
        if (msg.type === 'decode-success') {
          handler.resolve({
            width: msg.width,
            height: msg.height,
            rgb: new Uint8Array(msg.rgb),
            asShotTemperature: msg.asShotTemperature,
            asShotTint: msg.asShotTint,
          });
        } else {
          handler.reject(new Error(msg.message));
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
    return new Promise<DecodedImage>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
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
