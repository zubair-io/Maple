/**
 * Wire protocol shared by the face child process (`face-pool.child.ts`) and
 * its manager (`face-pool.ts`).
 *
 * Kept in its own module so both sides import the same request/response shapes
 * and can't drift, and so the worker doesn't have to import the manager (which
 * would pull the `Worker`-spawning class onto the worker thread).
 *
 * Only small values cross `postMessage`: the request carries the input JPEG
 * bytes (structured-cloned, never transferred — see `face-pool.ts`), and the
 * response carries either a `DetectedFace[]` or a 512-d `Float32Array`. The
 * heavy intermediates (NCHW tensors, the decoded RGB plane) stay on the worker.
 */

import type { DetectedFace } from './face-detector.ts';
import type { FaceModelsConfig, FaceModelsLoadStatus } from './face-models.ts';

/** Discriminator carried on a failed detect/embed response so the manager can
 * reconstruct the right error CLASS on the main thread. `postMessage` flattens
 * thrown errors to plain strings, but the stages branch on
 * `err instanceof ThumbDecodeError` to decide skip-vs-retry — so the kind must
 * survive the boundary explicitly. */
export type FaceWorkerErrorKind = 'thumb-decode' | 'generic';

export interface PreloadRequest {
  type: 'preload';
  id: number;
  config: FaceModelsConfig;
}

export interface DetectRequest {
  type: 'detect';
  id: number;
  jpegBytes: Uint8Array;
}

export interface EmbedRequest {
  type: 'embed';
  id: number;
  jpegBytes: Uint8Array;
  detection: DetectedFace;
}

export type FaceWorkerRequest = PreloadRequest | DetectRequest | EmbedRequest;

export interface PreloadResponse {
  type: 'preload';
  id: number;
  ok: boolean;
  error?: string;
}

export interface DetectResponse {
  type: 'detect';
  id: number;
  ok: boolean;
  detections?: DetectedFace[];
  errorKind?: FaceWorkerErrorKind;
  error?: string;
}

export interface EmbedResponse {
  type: 'embed';
  id: number;
  ok: boolean;
  embedding?: Float32Array;
  errorKind?: FaceWorkerErrorKind;
  error?: string;
}

/** Pushed (not request-correlated) whenever the worker's model load changes
 * state, so the manager can mirror it into the main-thread `liveStatus` that
 * powers the /settings/enrichment badge. */
export interface LoadStatusResponse {
  type: 'loadStatus';
  kind: FaceModelsLoadStatus;
  errorDetail?: string;
}

export type FaceWorkerResponse =
  | PreloadResponse
  | DetectResponse
  | EmbedResponse
  | LoadStatusResponse;
