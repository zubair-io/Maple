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

export type WorkerResponse = DecodeSuccess | DecodeError | WorkerStatus;

export interface DecodedImage {
  width: number;
  height: number;
  rgb: Uint8Array; // view over the transferred buffer
}
