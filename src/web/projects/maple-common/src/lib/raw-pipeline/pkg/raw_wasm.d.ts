// raw_wasm.d.ts — Type stub for the wasm-pack output.
//
// This file satisfies TypeScript's module resolution during `ng build` and
// `ng test` (the Angular builder resolves all `src/**/*.ts` imports, including
// workers, even when no fixture is present).  The actual runtime module is the
// wasm-pack–generated `raw_wasm.js` + `raw_wasm_bg.wasm` pair synced by
// `src/web/scripts/sync-raw-wasm.sh`.
//
// To build the real runtime bundle (required for development / production):
//   cd src/raw-pipeline/raw-wasm
//   wasm-pack build --target web              # standard
//   wasm-pack build --target web --features pano   # + panorama stitch
// Then sync:
//   ./src/web/scripts/sync-raw-wasm.sh
//
// IMPORTANT: This file must stay in sync with the wasm-bindgen surface
// declared in src/raw-pipeline/raw-wasm/src/lib.rs.  When a new #[wasm_bindgen]
// export is added, add the corresponding declaration here.

// ---- init -------------------------------------------------------------------

/** Default export: initialise the WASM module. */
export default function init(input?: RequestInfo | URL | Response | BufferSource): Promise<void>;

// ---- thread pool (parallel feature) ----------------------------------------

/** Initialise the rayon thread pool (only present in parallel builds). */
export function initThreadPool(numThreads: number): Promise<void>;

// ---- utilities --------------------------------------------------------------

export function install_panic_hook(): void;
export function is_threaded(): boolean;
export function version(): string;

// ---- render_bytes (legacy sRGB) ---------------------------------------------

export class MapleRender {
  readonly width: number;
  readonly height: number;
  readonly rgb: Uint8Array;
  readonly as_shot_temperature: number;
  readonly as_shot_tint: number;
}

export function render_bytes(
  raw: Uint8Array,
  ext: string,
  xmp: string | null,
): MapleRender;

// ---- render_bytes_scene_linear (fp16 RGBA) ----------------------------------

export class MapleSceneLinearRender {
  readonly width: number;
  readonly height: number;
  readonly fp16_rgba: Uint16Array;
  readonly bytes_per_pixel: number;
  readonly channels: number;
  readonly as_shot_temperature: number;
  readonly as_shot_tint: number;
}

export function render_bytes_scene_linear(
  raw: Uint8Array,
  ext: string,
  xmp: string | null,
  quality_preview: boolean,
): MapleSceneLinearRender;

// ---- panorama (pano feature) ------------------------------------------------

/** Stitch configuration (T5.5). */
export class PanoramaOptions {
  constructor();
  projection: number;    // 0 = rectilinear, 1 = cylindrical, 2 = spherical
  parallax_mode: number; // 0 = homography, 1 = TPS
  max_dimension: number; // 0 = unconstrained
}

/** Stitched-panorama handle (T2.3 / T5.5). */
export class PanoHandle {
  readonly width: number;
  readonly height: number;

  /** Stitch PNG/JPEG Uint8Array entries into a panorama. */
  static stitch(images: Uint8Array[], options: PanoramaOptions): PanoHandle;

  /** f32 RGB pixel buffer, interleaved, row-major. Clones on every call. */
  pixelsF32(): Float32Array;

  /** f16 RGB pixel buffer (stored as Uint16Array), interleaved, row-major. Clones on every call. */
  pixelsF16(): Uint16Array;
}
