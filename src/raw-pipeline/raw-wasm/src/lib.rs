//! wasm-bindgen surface for raw-core. Intended for consumption by the
//! Angular web workspace's `maple-common` package (per spec § 00).
//!
//! Browser-safe surface (no filesystem):
//!
//!   render_bytes(raw: Uint8Array, ext: string, xmp: string | null)
//!       → MapleRender { width: u32, height: u32, rgb: Uint8Array }
//!
//! Threading (T10):
//! When compiled with `--features parallel` and the `+atomics,+bulk-memory`
//! target features, `initThreadPool(num_threads)` is re-exported from
//! `wasm-bindgen-rayon`. JS callers invoke it only when
//! `crossOriginIsolated` is true (COOP: same-origin + COEP: require-corp).
//! Without those headers (Safari/Firefox default, or any host without them),
//! the decode path continues to work single-threaded — no feature detection
//! is needed on the Rust side.

use raw_core::xmp as xmp_mod;
use wasm_bindgen::prelude::*;

// Re-export wasm-bindgen-rayon's `initThreadPool` when the `parallel` feature
// is enabled. JS imports it as `initThreadPool` from the generated bindings.
#[cfg(all(target_arch = "wasm32", feature = "parallel"))]
pub use wasm_bindgen_rayon::init_thread_pool;

/// `true` when this WASM binary was built with atomics + the parallel feature.
/// JS can still override by refusing to call `initThreadPool` when
/// `crossOriginIsolated` is false (e.g. Safari or Firefox without COOP/COEP).
#[wasm_bindgen]
pub fn is_threaded() -> bool {
    cfg!(all(target_arch = "wasm32", target_feature = "atomics", feature = "parallel"))
}

/// One-shot panic hook installer. Safe to call multiple times. JS calls this
/// once immediately after `init()` so that Rust panics surface in DevTools
/// instead of becoming opaque `RuntimeError: unreachable` traps.
#[wasm_bindgen]
pub fn install_panic_hook() {
    #[cfg(target_arch = "wasm32")]
    {
        console_error_panic_hook::set_once();
    }
}

#[wasm_bindgen]
pub struct MapleRender {
    width: u32,
    height: u32,
    rgb: Vec<u8>,
    as_shot_temperature: f32,
    as_shot_tint: f32,
}

#[wasm_bindgen]
impl MapleRender {
    #[wasm_bindgen(getter)]
    pub fn width(&self) -> u32 { self.width }
    #[wasm_bindgen(getter)]
    pub fn height(&self) -> u32 { self.height }
    #[wasm_bindgen(getter)]
    pub fn rgb(&self) -> Vec<u8> { self.rgb.clone() }
    /// Camera-side "As Shot" correlated colour temperature in Kelvin, as
    /// determined by rawler from the RAW metadata. When the RAW lacks an
    /// explicit CCT we fall back to 6500K (D65) so callers always get a
    /// usable value.
    #[wasm_bindgen(getter)]
    pub fn as_shot_temperature(&self) -> f32 { self.as_shot_temperature }
    /// "As Shot" tint in Maple's slider units (-100 .. 100). Approximated
    /// from the camera's AsShotNeutral (blue vs red skew). 0 when the RAW
    /// does not expose enough information.
    #[wasm_bindgen(getter)]
    pub fn as_shot_tint(&self) -> f32 { self.as_shot_tint }
}

/// Rough CCT estimator from a green-normalised AsShotNeutral (R, 1, B).
/// Anchors: log2(B/R) = 0 → 5500K, ±1 → ±2500K. Good to within ~500K for
/// the common daylight/tungsten/cloudy range — better than the 6500K
/// fallback that otherwise shows up when rawler can't surface CCT itself.
fn estimate_cct_from_neutral(as_shot_neutral: [f32; 3]) -> f32 {
    let r = as_shot_neutral[0].max(0.01);
    let b = as_shot_neutral[2].max(0.01);
    let log2_ratio = (b / r).ln() / core::f32::consts::LN_2;
    (5500.0 + log2_ratio * 2500.0).clamp(2000.0, 12000.0)
}

/// Render a RAW from bytes (WASM-friendly — no filesystem path needed).
///
/// `ext` is a lowercase file extension like `"dng"`, `"cr2"`, `"arw"` so
/// rawler can disambiguate formats when magic is ambiguous.
///
/// `xmp` is optional XMP sidecar content as a UTF-8 string (not a path).
/// When `xmp` is `None` we assume the caller is opening a brand-new RAW
/// (no prior user adjustments) and substitute the camera's AsShotNeutral-
/// derived white balance for Maple's 6500K default — otherwise every fresh
/// import would render with a strong colour cast before the user has
/// touched the Temperature slider.
#[wasm_bindgen]
pub fn render_bytes(raw: &[u8], ext: &str, xmp: Option<String>) -> Result<MapleRender, JsError> {
    let raw_img = raw_core::decode::decode_bytes(raw, ext)
        .map_err(|e| JsError::new(&e.to_string()))?;

    // rawler 0.7 doesn't surface AsShotTemperature, so `as_shot_cct` is
    // always None today. Fall back to estimating the CCT from the camera's
    // AsShotNeutral reading — same signal Adobe uses when the DNG lacks a
    // baked Kelvin tag.
    let as_shot_temperature = raw_img
        .as_shot_cct
        .unwrap_or_else(|| estimate_cct_from_neutral(raw_img.as_shot_neutral));
    // Tint is best left at 0 on cold open — deriving it from a single
    // neutral reading without the camera's DCP hue map misleads the slider.
    // The user can nudge it manually once the temperature is in the ballpark.
    let as_shot_tint = 0.0_f32;

    let fresh_open = xmp.is_none();
    let mut model = match xmp {
        Some(x) => xmp_mod::parse(&x).map_err(|e| JsError::new(&e.to_string()))?,
        None => xmp_mod::AdjustmentModel::default(),
    };
    // Fresh open (no sidecar) → render at the camera's As Shot WB, not the
    // 6500K default the struct carries. User edits always come in through
    // `xmp = Some(..)` once they've moved a slider, so this branch only
    // kicks in for a first-render cold open.
    if fresh_open {
        model.temperature = as_shot_temperature;
        model.tint = as_shot_tint;
    }

    let (w, h, bytes) = raw_core::pipeline::render_from_raw(&raw_img, &model)
        .map_err(|e| JsError::new(&e.to_string()))?;
    Ok(MapleRender {
        width: w,
        height: h,
        rgb: bytes,
        as_shot_temperature,
        as_shot_tint,
    })
}

/// Version string (for build verification from JS).
#[wasm_bindgen]
pub fn version() -> String {
    env!("CARGO_PKG_VERSION").to_string()
}
