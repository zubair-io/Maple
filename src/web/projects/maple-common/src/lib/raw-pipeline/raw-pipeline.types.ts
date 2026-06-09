// Shared types for raw-pipeline worker communication.

export interface DecodeRequest {
  id: number; // round-trip correlation id
  type: 'decode';
  bytes: ArrayBuffer; // transferable
  ext: string;
  xmp?: string;
  /**
   * Route this render through the wgpu+WGSL GPU live chain (`render_bytes_gpu`)
   * instead of the WASM-CPU `render_bytes` path (epic #925, P4b-web / #1029).
   * Set from `GPU_LIVE_RENDER_ENABLED`. The worker honours it only when the
   * loaded WASM bundle actually exports `render_bytes_gpu` (the `gpu`-feature
   * build); otherwise — and when absent/false — it falls back to `render_bytes`,
   * so a flag-on request against the default (gpu-off) bundle is still correct.
   * The `decode-success` response shape is identical either way (u8 RGB).
   */
  gpu?: boolean;
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

// ── Persistent GPU live-session (epic #925, P4b-web / #1038) ─────────────────
// The 16ms-ready web live-render path: the worker keeps a `WebLiveSession`
// (cached GPU context + uploaded image) resident across slider ticks and presents
// straight to a transferred `OffscreenCanvas` with NO CPU readback. Distinct from
// the one-shot `decode(gpu)` path (#1029), which still returns u8 RGB for the 2D
// canvas + the gpu-off-bundle fallback. Gated behind `GPU_LIVE_RENDER_ENABLED`;
// the worker further requires the `gpu`-feature WASM bundle (else it reports an
// error and the component falls back to the 2D `decode()` path).

/** Open a persistent live session: transfers the `OffscreenCanvas` + the RAW. */
export interface OpenSessionRequest {
  id: number;
  type: 'open-session';
  bytes: ArrayBuffer; // transferable RAW bytes
  ext: string;
  xmp?: string;
  /** The editor canvas, transferred via `transferControlToOffscreen()`. */
  canvas: OffscreenCanvas; // transferable
}

/** Re-render the open session for a new develop model (the #846 edit path). */
export interface RenderSessionRequest {
  id: number;
  type: 'render-session';
  xmp?: string;
}

/** Tear down the open session (asset switch / component destroy). */
export interface CloseSessionRequest {
  id: number;
  type: 'close-session';
}

/** Reply to `open-session`: the session is live + presenting its first frame. */
export interface OpenSessionSuccess {
  id: number;
  type: 'open-session-success';
  width: number;
  height: number;
  asShotTemperature: number;
  asShotTint: number;
  /** Achieved canvas colour-space tag (`display-p3` / `srgb` / `unknown`). */
  colorSpace: string;
}

/** Reply to `render-session`: a frame was presented to the surface. */
export interface RenderSessionSuccess {
  id: number;
  type: 'render-session-success';
  colorSpace: string;
}

/** Error from any session op (incl. "gpu bundle absent" → component falls back). */
export interface SessionError {
  id: number;
  type: 'session-error';
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
  | OpenSessionSuccess
  | RenderSessionSuccess
  | SessionError
  | WorkerStatus
  | WorkerLog;

/** All request messages the raw-pipeline worker accepts. */
export type WorkerRequest =
  | DecodeRequest
  | DecodeSceneLinearRequest
  | OpenSessionRequest
  | RenderSessionRequest
  | CloseSessionRequest;

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
