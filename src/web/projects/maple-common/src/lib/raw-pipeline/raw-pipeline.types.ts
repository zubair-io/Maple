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
  /**
   * Cap the render's long edge in REAL (backing-store) pixels (#1101, spec
   * §5.1): the worker routes to the sized entry (`render_bytes_sized`), which
   * downsamples right after demosaic so every later stage runs at the capped
   * size. Never upscales. When set, the render runs on the threaded-CPU sized
   * path (the editor's 2D fast/refine phases — the GPU live path uses the
   * persistent session instead, see `OpenSessionRequest`, whose develop is fit
   * to the same target per #1080). The GPU one-shot route (`render_bytes_gpu`)
   * shares the contract — same name, same units, same never-upscale — and the
   * worker passes the field through to it; unsized GPU one-shots self-cap at
   * the WASM-side 2048 default (#1080), so no route develops a 100 MP frame at
   * full sensor res.
   */
  maxLongEdge?: number;
  /**
   * Only honoured with `maxLongEdge`: `true` runs the half-res Preview
   * demosaic (the fast-phase cost profile), `false`/absent runs Full (the
   * refine phase). The unsized path stays Full-quality, as today.
   */
  qualityPreview?: boolean;
}

export interface DecodeSuccess {
  id: number;
  type: 'decode-success';
  width: number;
  height: number;
  rgb: ArrayBuffer; // transferable RGB bytes (3 * w * h)
  /**
   * Oriented dims a full-resolution render of the same RAW would produce.
   * Equal to `width`/`height` for unsized decodes; a `maxLongEdge` decode
   * carries the native dims here so the editor keeps its fit/100% zoom math
   * while holding only a viewport-sized buffer (#1101).
   */
  nativeWidth: number;
  nativeHeight: number;
  /** Camera "As Shot" CCT in Kelvin (rawler-derived). */
  asShotTemperature: number;
  /** Camera "As Shot" tint in slider units (-150..150 — ACR's crs:Tint span, #1870). */
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
  /**
   * Viewport target in REAL (backing-store) pixels (#1080): the session's
   * develop fits the image to this long edge (aspect preserved, never
   * upscaled) and sizes the canvas to the developed dims, so a 100 MP frame
   * no longer configures an over-texture-cap surface (black canvas) or
   * allocates ~2.8 GB of transient f32 in the wasm heap. Absent/0 ⇒ the
   * WASM-side 2048 default cap (the downlevel WebGPU texture baseline).
   */
  maxLongEdge?: number;
}

/** Re-render the open session for a new develop model (the #846 edit path). */
export interface RenderSessionRequest {
  id: number;
  type: 'render-session';
  xmp?: string;
  params?: Float32Array;
}

/** Tear down the open session (asset switch / component destroy). */
export interface CloseSessionRequest {
  id: number;
  type: 'close-session';
}

/**
 * A small, downsampled RGB snapshot of the GPU-presented frame, read back on the
 * worker side so the histogram/waveform/parade/vectorscope scopes have a pixel
 * source on the zero-readback GPU live path (#1045). Packed display-RGB
 * (`3 * width * height`), the SAME contract as `DecodeSuccess.rgb` — the scopes
 * are statistical reductions and were fed sRGB-ish bytes on the CPU path too, so
 * a downsampled p3-or-srgb readback is an apt source.
 *
 * OPTIONAL on every session reply: the readback is wrapped in try/catch in the
 * worker, so a gpu-off bundle, a non-`drawImage`-able surface, or any failure
 * simply omits it — the component then leaves `currentPixels` null and the scopes
 * fall back to their pseudo render, i.e. exactly today's flag-on behaviour (no
 * regression). Tiny by construction (long edge clamped), so folding it into the
 * existing reply costs ~one extra small transfer, no new round-trip.
 */
export interface ScopeSnapshot {
  width: number;
  height: number;
  rgb: ArrayBuffer; // transferable, packed RGB (3 * width * height)
}

/** Reply to `open-session`: the session is live + presenting its first frame. */
export interface OpenSessionSuccess {
  id: number;
  type: 'open-session-success';
  /** Developed (viewport-sized per #1080) dims — also the canvas dims. */
  width: number;
  height: number;
  /**
   * NATIVE oriented dims — what a full-res render would produce (see
   * `DecodeSuccess.nativeWidth`). The session is viewport-sized (#1080), so
   * the editor records THESE on the asset for its fit/100% zoom math (#1101).
   */
  nativeWidth: number;
  nativeHeight: number;
  asShotTemperature: number;
  asShotTint: number;
  /** Achieved canvas colour-space tag (`display-p3` / `srgb` / `unknown`). */
  colorSpace: string;
  /** Downsampled RGB readback of the first presented frame, for the scopes (#1045). */
  scope?: ScopeSnapshot;
}

/** Reply to `render-session`: a frame was presented to the surface. */
export interface RenderSessionSuccess {
  id: number;
  type: 'render-session-success';
  colorSpace: string;
  /** Downsampled RGB readback of the presented frame, for the scopes (#1045). */
  scope?: ScopeSnapshot;
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
  | WorkerLog
  | AutoAdjustSuccess
  | AutoAdjustError
  | ExportSuccess
  | ExportError;

// ── Auto-adjust one-shot (#1379) ─────────────────────────────────────────────
// Standalone decode + probe: the worker calls `compute_auto_adjustments_from_bytes`
// with the RAW bytes and (optionally) the current XMP, returning the 8-field
// recommended slider patch. The caller MUST apply `autoExposure: 'Off'` alongside
// `exposure` (the returned value is measured against an AE-Off probe). The five
// tone fields are returned for completeness but the Angular consumer intentionally
// applies ONLY `{ exposure, temperature, tint, autoExposure: 'Off',
// whiteBalancePreset: 'Custom' }` — tone auto is deferred to #1376.

/** Request the worker to analyse a RAW and return auto adjustment recommendations (#1379). */
export interface AutoAdjustRequest {
  id: number;
  type: 'auto-adjust';
  /** Transferable RAW bytes — consumed by the worker; do NOT re-use after posting. */
  bytes: ArrayBuffer;
  /** Lowercase file extension, e.g. `"dng"`. */
  ext: string;
  /** Optional current XMP sidecar text (passed to the WASM; `undefined` = fresh open). */
  xmp?: string;
}

/**
 * The 8-field recommendation returned by the WASM `compute_auto_adjustments_from_bytes`.
 * `exposure` is in EV; `temperature` is in Kelvin; `tint` and the five tone fields are in
 * ±100 units. Tone fields are ALWAYS 0 in M0 (deferred to #1376) — the caller must NOT
 * write them.
 */
export interface AutoAdjustPatch {
  exposure: number;
  temperature: number;
  tint: number;
  contrast: number;
  highlights: number;
  shadows: number;
  whites: number;
  blacks: number;
}

/** Worker → main thread: auto-adjust computation succeeded. */
export interface AutoAdjustSuccess {
  id: number;
  type: 'auto-adjust-success';
  patch: AutoAdjustPatch;
}

/** Worker → main thread: auto-adjust computation failed. */
export interface AutoAdjustError {
  id: number;
  type: 'auto-adjust-error';
  message: string;
}

// ── Edited-image export (#943) ───────────────────────────────────────────────
// Full-resolution render + encode, both inside the WASM module: only the
// compressed file crosses the boundary, and it crosses in chunks that the
// worker accumulates into a `Blob`. A 100 MP 16-bit TIFF is ~600 MB, so
// handing JS a pixel buffer (or even one contiguous encoded `ArrayBuffer`)
// would put the export one allocation away from an out-of-memory kill; a Blob
// is backed by browser storage rather than the JS heap.

/** Containers the export can be written to. Wire values match `raw-core`. */
export type ExportFormat = 'jpeg' | 'tiff' | 'png';

/** Output primaries. `display-p3` matches the canvas colour-space tag. */
export type ExportColorSpace = 'srgb' | 'display-p3';

/** The user-facing export settings. */
export interface RawExportOptions {
  format: ExportFormat;
  /** JPEG quality, 1–100. Ignored by the lossless formats. */
  quality: number;
  colorSpace: ExportColorSpace;
  /**
   * Cap on the longest output edge in pixels. Omit (or 0) for native full
   * resolution. Never upscales.
   */
  maxSidePixels?: number;
}

/** Ask the worker to render + encode a deliverable file. */
export interface ExportRequest {
  id: number;
  type: 'export';
  /** Transferable RAW bytes — consumed by the worker; do NOT re-use after posting. */
  bytes: ArrayBuffer;
  ext: string;
  /** Sidecar XMP text, so the export reads the same edits the canvas showed. */
  xmp?: string;
  options: RawExportOptions;
}

/** Reply to `export`: the encoded file, as a Blob the caller can download. */
export interface ExportSuccess {
  id: number;
  type: 'export-success';
  /** Dimensions actually written, after resize / crop / orientation. */
  width: number;
  height: number;
  /** Filename extension for the chosen format, without the dot. */
  extension: string;
  /** The encoded file. Already tagged with the format's MIME type. */
  blob: Blob;
}

export interface ExportError {
  id: number;
  type: 'export-error';
  message: string;
}

/** Main-thread view of a completed export. */
export interface ExportedFile {
  width: number;
  height: number;
  extension: string;
  blob: Blob;
}

/** All request messages the raw-pipeline worker accepts. */
export type WorkerRequest =
  | DecodeRequest
  | DecodeSceneLinearRequest
  | OpenSessionRequest
  | RenderSessionRequest
  | CloseSessionRequest
  | AutoAdjustRequest
  | ExportRequest;

export interface DecodedImage {
  width: number;
  height: number;
  rgb: Uint8Array; // view over the transferred buffer
  asShotTemperature: number;
  asShotTint: number;
  /**
   * Native oriented dims (see `DecodeSuccess.nativeWidth`). Optional for
   * back-compat with producers that never size down (non-RAW browser decode,
   * GPU scope readbacks) — absent means `width`/`height` ARE native.
   */
  nativeWidth?: number;
  nativeHeight?: number;
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
  /**
   * Cap the render's long edge (#1101, spec §5.1): routes to
   * `render_bytes_scene_linear_sized`, the WASM mirror of the Apple FFI's
   * `maple_render_bytes_scene_linear_sized`. Never upscales.
   */
  maxLongEdge?: number;
}

export interface DecodeSceneLinearSuccess {
  id: number;
  type: 'decode-scene-linear-success';
  width: number;
  height: number;
  /** Native oriented dims — see `DecodeSuccess.nativeWidth` (#1101). */
  nativeWidth: number;
  nativeHeight: number;
  /**
   * Transferable fp16 RGBA buffer. Length is `8 * width * height` bytes
   * (4 channels * 2 bytes per fp16 lane). Alpha lane is fp16 1.0 (0x3c00).
   * Same bit pattern as Apple's `MapleSceneLinearBuffer.fp16_rgba`.
   */
  fp16Rgba: ArrayBuffer;
  /** Camera "As Shot" CCT in Kelvin (rawler-derived). */
  asShotTemperature: number;
  /** Camera "As Shot" tint in slider units (-150..150 — ACR's crs:Tint span, #1870). */
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
  /** Native oriented dims (see `DecodedImage.nativeWidth`); optional for back-compat. */
  nativeWidth?: number;
  nativeHeight?: number;
}
