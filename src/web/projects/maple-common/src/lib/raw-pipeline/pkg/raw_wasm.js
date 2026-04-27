// raw_wasm.js — Module stub for wasm-pack output.
//
// This file satisfies esbuild / Angular-compiler module resolution during
// `ng build` and `ng test` when the real wasm-pack bundle has not been synced
// yet.  It exports the same surface as the generated `raw_wasm.js` so that
// worker and service code compiles without errors.
//
// At runtime the worker calls `await init()` before anything else.  The stub
// `init()` rejects with a clear message so developers get an actionable error
// rather than a silent no-op:
//
//   [raw-wasm stub] WASM bundle not found. Run:
//     cd src/raw-pipeline/raw-wasm && wasm-pack build --target web [--features pano]
//   then: ./src/web/scripts/sync-raw-wasm.sh
//
// The stub is never shipped — it lives only in the source tree.  In production
// builds the sync script replaces pkg/ with the real wasm-pack output.

const STUB_ERROR =
  '[raw-wasm stub] WASM bundle not synced. Run:\n' +
  '  cd src/raw-pipeline/raw-wasm\n' +
  '  wasm-pack build --target web [--features pano]\n' +
  'then:\n' +
  '  ./src/web/scripts/sync-raw-wasm.sh';

export default async function init() {
  throw new Error(STUB_ERROR);
}

export async function initThreadPool() {
  throw new Error(STUB_ERROR);
}

export function install_panic_hook() {}
export function is_threaded() { return false; }
export function version() { return '0.0.0-stub'; }

export class MapleRender {
  get width() { return 0; }
  get height() { return 0; }
  get rgb() { return new Uint8Array(0); }
  get as_shot_temperature() { return 6500; }
  get as_shot_tint() { return 0; }
}

export function render_bytes() {
  throw new Error(STUB_ERROR);
}

export class MapleSceneLinearRender {
  get width() { return 0; }
  get height() { return 0; }
  get fp16_rgba() { return new Uint16Array(0); }
  get bytes_per_pixel() { return 8; }
  get channels() { return 4; }
  get as_shot_temperature() { return 6500; }
  get as_shot_tint() { return 0; }
}

export function render_bytes_scene_linear() {
  throw new Error(STUB_ERROR);
}

export class PanoramaOptions {
  constructor() {
    this.projection = 1;
    this.parallax_mode = 0;
    this.max_dimension = 0;
  }
}

export class PanoHandle {
  get width() { return 0; }
  get height() { return 0; }
  static stitch() { throw new Error(STUB_ERROR); }
  pixelsF32() { return new Float32Array(0); }
  pixelsF16() { return new Uint16Array(0); }
}
