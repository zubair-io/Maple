/**
 * Single-worker face-inference pool. Off-main-thread SCRFD detect + ArcFace
 * embed so the synchronous `onnxruntime-node` `session.run()` calls (and the
 * per-face/per-asset `alignFaceCrop` / `decodeScrfdOutputs` CPU loops) don't
 * freeze the HTTP event loop. Ticket #707.
 *
 * Shape mirrors the two in-repo precedents:
 *   - `ffi/ffi-pool.ts`     — lazy single-worker spawn, request-id pending Map,
 *                             multiple request methods, error handler that
 *                             rejects in-flight calls and respawns next call.
 *   - `people/cluster-pool.ts` — graceful in-process fallback when Bun's
 *                             `Worker` can't spawn (sandbox / unsupported
 *                             runtime / CI shells), degrading with a warning.
 *
 * Why one worker (not N): the face stages run with `concurrency: 1` (the ONNX
 * sessions are single-threaded; see `face-detect.ts` / `face-embed.ts`), so
 * there's at most one in-flight inference. Adding workers would just multiply
 * the ~hundreds-of-MB model load across threads without unblocking anything.
 * One worker, lazily spawned, lives for the process.
 *
 * `PooledFaceDetector` implements the same `FaceDetector` interface the stages
 * already depend on, so `defaultFaceDetector()` swaps the in-process
 * `OnnxFaceDetector` for the pool transparently. The worker runs the real
 * `OnnxFaceDetector` wholesale, so output is identical — this is a timing
 * change, never a results change.
 */

import { child as childLogger } from '../log.ts';
import {
  ThumbDecodeError,
  type DetectedFace,
  type FaceDetector,
  OnnxFaceDetector,
} from './face-detector.ts';
import { relayFaceModelsStatus, type FaceModelsConfig } from './face-models.ts';
import type {
  DetectResponse,
  EmbedResponse,
  FaceWorkerErrorKind,
  FaceWorkerResponse,
  LoadStatusResponse,
  PreloadResponse,
} from './face-pool-protocol.ts';

const log = childLogger('enrichment:face-pool');

interface PendingDetect {
  kind: 'detect';
  resolve: (faces: DetectedFace[]) => void;
  reject: (err: Error) => void;
}

interface PendingEmbed {
  kind: 'embed';
  resolve: (embedding: Float32Array) => void;
  reject: (err: Error) => void;
}

interface PendingPreload {
  kind: 'preload';
  resolve: (ok: boolean) => void;
  reject: (err: Error) => void;
}

type Pending = PendingDetect | PendingEmbed | PendingPreload;

/** Reconstruct the right error CLASS on the main thread from the worker's
 * discriminator. `ThumbDecodeError` must come back as a `ThumbDecodeError` so
 * the stages' `instanceof` skip-vs-retry branch keeps working across the
 * worker boundary. */
function reviveError(kind: FaceWorkerErrorKind | undefined, message: string): Error {
  return kind === 'thumb-decode' ? new ThumbDecodeError(message) : new Error(message);
}

class FaceWorkerPool {
  private worker: Worker | null = null;
  private pending = new Map<number, Pending>();
  private nextId = 1;
  private workerLoadFailed = false;
  /** In-process fallback, lazily constructed only when no Worker can spawn.
   * Re-introduces the event-loop block, but keeps environments without Worker
   * support working rather than hard-failing — same trade-off as
   * `cluster-pool.ts`. The fallback runs the same `OnnxFaceDetector`, so output
   * is identical to the worker path. */
  private fallback: OnnxFaceDetector | null = null;
  /** Test seam: force the in-process path so the fallback can be exercised
   * deterministically without an unspawnable-Worker environment. NOT a
   * production stub — production never sets this. */
  private forceFallback = false;

  /** Force / unforce the in-process fallback. Test-only. */
  setForceInProcess(force: boolean): void {
    this.forceFallback = force;
  }

  private inProcess(): OnnxFaceDetector {
    if (!this.fallback) this.fallback = new OnnxFaceDetector();
    return this.fallback;
  }

  /** Lazy worker spawn. Throws if Bun's `Worker` API is unavailable so the
   *  caller can fall back to in-process inference. */
  private ensureWorker(): Worker {
    if (this.worker) return this.worker;
    if (this.workerLoadFailed) {
      throw new Error('face-pool: worker previously failed to start');
    }

    let w: Worker;
    try {
      w = new Worker(new URL('./face-pool.worker.ts', import.meta.url).href);
    } catch (e) {
      this.workerLoadFailed = true;
      throw new Error(
        'face-pool: failed to spawn worker — ' + (e instanceof Error ? e.message : String(e)),
      );
    }

    w.addEventListener('message', (event) => {
      this.onMessage(event.data as FaceWorkerResponse);
    });

    w.addEventListener('error', (event) => {
      // Reject every in-flight call so callers don't hang. The next request
      // spawns a fresh worker.
      const err = new Error('face-pool: worker errored — ' + (event.message || 'unknown'));
      for (const p of this.pending.values()) p.reject(err);
      this.pending.clear();
      this.worker?.terminate();
      this.worker = null;
    });

    this.worker = w;
    return w;
  }

  private onMessage(msg: FaceWorkerResponse): void {
    if (!msg || typeof msg !== 'object') return;
    if (msg.type === 'loadStatus') {
      const m = msg as LoadStatusResponse;
      relayFaceModelsStatus(m.kind, m.errorDetail ?? null);
      return;
    }
    const p = this.pending.get(msg.id);
    if (!p) return;
    this.pending.delete(msg.id);

    if (msg.type === 'detect' && p.kind === 'detect') {
      const m = msg as DetectResponse;
      if (m.ok && m.detections) p.resolve(m.detections);
      else p.reject(reviveError(m.errorKind, m.error ?? 'face-pool: detect failed'));
      return;
    }
    if (msg.type === 'embed' && p.kind === 'embed') {
      const m = msg as EmbedResponse;
      if (m.ok && m.embedding) p.resolve(m.embedding);
      else p.reject(reviveError(m.errorKind, m.error ?? 'face-pool: embed failed'));
      return;
    }
    if (msg.type === 'preload' && p.kind === 'preload') {
      const m = msg as PreloadResponse;
      // preload never rejects on a load failure — it resolves false so the
      // bootstrap leaves the worker dormant (matching the old main-thread
      // behaviour). It rejects only on a transport-level mismatch.
      p.resolve(m.ok);
      return;
    }
    // Type/kind mismatch — reject so the caller doesn't hang silently.
    p.reject(new Error(`face-pool: response/pending kind mismatch for id ${msg.id}`));
  }

  /** Detect faces in `jpegBytes`. Resolves with the detection array. Rejects
   *  with `ThumbDecodeError` for undecodable thumbnails (so stages skip) or a
   *  plain `Error` for retryable failures. */
  detectFaces(jpegBytes: Uint8Array): Promise<DetectedFace[]> {
    if (this.forceFallback) return this.inProcess().detectFaces(jpegBytes);
    let worker: Worker;
    try {
      worker = this.ensureWorker();
    } catch (e) {
      log.warn(
        { err: e instanceof Error ? e.message : String(e) },
        'face worker unavailable — detecting in-process (blocks the event loop)',
      );
      return this.inProcess().detectFaces(jpegBytes);
    }
    const id = this.nextId++;
    return new Promise<DetectedFace[]>((resolve, reject) => {
      this.pending.set(id, { kind: 'detect', resolve, reject });
      try {
        // Structured-clone copy (default postMessage), NOT transfer: the
        // caller (`faceEmbedHandler`) reuses the same `jpegBytes` buffer for
        // every face on the asset, so transferring would detach it after the
        // first call. Same decision as `cluster-pool.ts`.
        worker.postMessage({ type: 'detect', id, jpegBytes });
      } catch (e) {
        this.pending.delete(id);
        reject(e instanceof Error ? e : new Error(String(e)));
      }
    });
  }

  /** Embed one detected face. Resolves with the 512-d L2-normalised embedding.
   *  Same reject semantics as `detectFaces`. */
  embedFace(jpegBytes: Uint8Array, detection: DetectedFace): Promise<Float32Array> {
    if (this.forceFallback) return this.inProcess().embedFace(jpegBytes, detection);
    let worker: Worker;
    try {
      worker = this.ensureWorker();
    } catch (e) {
      log.warn(
        { err: e instanceof Error ? e.message : String(e) },
        'face worker unavailable — embedding in-process (blocks the event loop)',
      );
      return this.inProcess().embedFace(jpegBytes, detection);
    }
    const id = this.nextId++;
    return new Promise<Float32Array>((resolve, reject) => {
      this.pending.set(id, { kind: 'embed', resolve, reject });
      try {
        worker.postMessage({ type: 'embed', id, jpegBytes, detection });
      } catch (e) {
        this.pending.delete(id);
        reject(e instanceof Error ? e : new Error(String(e)));
      }
    });
  }

  /** Warm the model sessions inside the worker so the first claim doesn't pay
   *  the cold-load cost, and relay load status to the main-thread badge.
   *  Resolves true if the models loaded, false otherwise (non-fatal — the
   *  first inference retries). Falls back to a main-thread preload when no
   *  worker can spawn. */
  preload(config: FaceModelsConfig): Promise<boolean> {
    if (this.forceFallback) return this.preloadInProcess(config);
    let worker: Worker;
    try {
      worker = this.ensureWorker();
    } catch (e) {
      log.warn(
        { err: e instanceof Error ? e.message : String(e) },
        'face worker unavailable — preloading models in-process',
      );
      return this.preloadInProcess(config);
    }
    const id = this.nextId++;
    return new Promise<boolean>((resolve, reject) => {
      this.pending.set(id, { kind: 'preload', resolve, reject });
      try {
        worker.postMessage({ type: 'preload', id, config });
      } catch (e) {
        this.pending.delete(id);
        reject(e instanceof Error ? e : new Error(String(e)));
      }
    });
  }

  /** In-process preload used by the fallback path. Loads on the main thread
   *  (which sets `liveStatus` directly) and swallows the error like the old
   *  bootstrap did — never throws. */
  private async preloadInProcess(config: FaceModelsConfig): Promise<boolean> {
    const { loadFaceModels } = await import('./face-models.ts');
    try {
      await loadFaceModels(config);
      return true;
    } catch (err) {
      log.warn(
        { err: err instanceof Error ? err.message : String(err) },
        'in-process face model preload failed; first inference will retry',
      );
      return false;
    }
  }
}

let _pool: FaceWorkerPool | null = null;

/** Process-wide face pool. Lazily constructed on first call. */
function facePool(): FaceWorkerPool {
  if (!_pool) _pool = new FaceWorkerPool();
  return _pool;
}

/**
 * The pooled `FaceDetector` the stages call through. Detect + embed run on the
 * worker thread; output is identical to the in-process `OnnxFaceDetector`.
 */
export class PooledFaceDetector implements FaceDetector {
  detectFaces(jpegBytes: Uint8Array): Promise<DetectedFace[]> {
    return facePool().detectFaces(jpegBytes);
  }

  embedFace(jpegBytes: Uint8Array, detection: DetectedFace): Promise<Float32Array> {
    return facePool().embedFace(jpegBytes, detection);
  }
}

/** Preload the face models inside the worker. Called by `face-bootstrap`. */
export function preloadFaceModelsOffThread(config: FaceModelsConfig): Promise<boolean> {
  return facePool().preload(config);
}

/** Test-only: force (or unforce) the in-process fallback path on the process
 *  pool so the fallback can be exercised without an unspawnable-Worker shell. */
export function setForceInProcessForTests(force: boolean): void {
  facePool().setForceInProcess(force);
}
