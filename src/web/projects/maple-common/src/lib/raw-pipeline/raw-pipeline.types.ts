// Shared types for raw-pipeline worker communication.

export interface DecodeRequest {
  id: number; // round-trip correlation id
  type: 'decode';
  bytes: ArrayBuffer; // transferable
  ext: string;
  xmp?: string;
}

export interface DecodeSuccess {
  id: number;
  type: 'decode-success';
  width: number;
  height: number;
  rgb: ArrayBuffer; // transferable RGB bytes (3 * w * h)
  /** Camera "As Shot" CCT in Kelvin (rawler-derived). */
  asShotTemperature: number;
  /** Camera "As Shot" tint in slider units (-100..100). */
  asShotTint: number;
}

export interface DecodeError {
  id: number;
  type: 'decode-error';
  message: string;
}

/** T10: broadcast from the worker after WASM init reports thread-pool state. */
export interface WorkerStatus {
  id: 0;
  type: 'status';
  threaded: boolean;
  threads: number;
}

/** Worker-side console output forwarded to the main thread (esp. for panic-hook errors). */
export interface WorkerLog {
  id: 0;
  type: 'worker-log';
  level: 'log' | 'warn' | 'error';
  text: string;
}

export type WorkerResponse =
  | DecodeSuccess
  | DecodeError
  | DecodeSceneLinearSuccess
  | DecodeSceneLinearError
  | WorkerStatus
  | WorkerLog;

export interface DecodedImage {
  width: number;
  height: number;
  rgb: Uint8Array; // view over the transferred buffer
  asShotTemperature: number;
  asShotTint: number;
}

export interface DecodeSceneLinearRequest {
  id: number; // round-trip correlation id, distinct from DecodeRequest's id space
  type: 'decode-scene-linear';
  bytes: ArrayBuffer; // transferable
  ext: string;
  xmp?: string;
  /**
   * `true` (default) runs the half-res Preview pipeline (matches Apple's
   * editor first-paint). `false` runs full-res Full — used for export.
   */
  qualityPreview: boolean;
}

export interface DecodeSceneLinearSuccess {
  id: number;
  type: 'decode-scene-linear-success';
  width: number;
  height: number;
  /**
   * Transferable fp16 RGBA buffer. Length is `8 * width * height` bytes
   * (4 channels * 2 bytes per fp16 lane). Alpha lane is fp16 1.0 (0x3c00).
   * Same bit pattern as Apple's `MapleSceneLinearBuffer.fp16_rgba`.
   */
  fp16Rgba: ArrayBuffer;
  /** Camera "As Shot" CCT in Kelvin (rawler-derived). */
  asShotTemperature: number;
  /** Camera "As Shot" tint in slider units (-100..100). */
  asShotTint: number;
}

export interface DecodeSceneLinearError {
  id: number;
  type: 'decode-scene-linear-error';
  message: string;
}

/**
 * Worker → main thread aggregate after a successful scene-linear decode.
 * `fp16Rgba` is a `Uint16Array` view over the transferred buffer (no
 * copy on construction). The Plan 3 M3 consumer will pass this directly
 * to `gl.texImage2D(..., gl.RGBA16F, ..., gl.RGBA, gl.HALF_FLOAT, fp16Rgba)`.
 */
export interface DecodedSceneLinearImage {
  width: number;
  height: number;
  fp16Rgba: Uint16Array;
  asShotTemperature: number;
  asShotTint: number;
}
