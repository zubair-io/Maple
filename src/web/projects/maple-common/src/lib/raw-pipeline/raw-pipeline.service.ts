// RawPipelineService — Angular wrapper around the raw-decode Web Worker.
// Lazy-creates the worker on first call, reuses for subsequent calls,
// terminates on app destroy. All decodes run off the main thread.

import { Injectable, OnDestroy } from '@angular/core';
import type { DecodedImage, DecodeRequest, WorkerResponse } from './raw-pipeline.types';

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

  private ensureWorker(): Worker {
    if (this.worker) return this.worker;
    try {
      this.worker = new Worker(new URL('./raw-pipeline.worker', import.meta.url), {
        type: 'module',
      });
      this.worker.addEventListener('message', (e: MessageEvent<WorkerResponse>) => {
        const msg = e.data;
        const handler = this.pending.get(msg.id);
        if (!handler) return;
        this.pending.delete(msg.id);
        if (msg.type === 'decode-success') {
          handler.resolve({
            width: msg.width,
            height: msg.height,
            rgb: new Uint8Array(msg.rgb),
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

  decode(bytes: Uint8Array, ext: string, xmp?: string): Promise<DecodedImage> {
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
