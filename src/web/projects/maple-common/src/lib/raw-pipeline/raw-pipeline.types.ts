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

export type WorkerResponse = DecodeSuccess | DecodeError | WorkerStatus | WorkerLog;

export interface DecodedImage {
  width: number;
  height: number;
  rgb: Uint8Array; // view over the transferred buffer
  asShotTemperature: number;
  asShotTint: number;
}
