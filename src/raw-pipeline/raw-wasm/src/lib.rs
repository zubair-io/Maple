//! wasm-bindgen surface for raw-core. Intended for consumption by the
//! Angular web workspace's `Maple-common` package (per spec § 00).
//!
//! Browser-safe surface (no filesystem):
//!
//!   render_bytes(raw: Uint8Array, ext: string, xmp: string | null)
//!       → MapleRender { width: u32, height: u32, rgb: Uint8Array }

use raw_core::xmp as xmp_mod;
use wasm_bindgen::prelude::*;

#[wasm_bindgen]
pub struct MapleRender {
    width: u32,
    height: u32,
    rgb: Vec<u8>,
}

#[wasm_bindgen]
impl MapleRender {
    #[wasm_bindgen(getter)]
    pub fn width(&self) -> u32 { self.width }
    #[wasm_bindgen(getter)]
    pub fn height(&self) -> u32 { self.height }
    #[wasm_bindgen(getter)]
    pub fn rgb(&self) -> Vec<u8> { self.rgb.clone() }
}

/// Render a RAW from bytes (WASM-friendly — no filesystem path needed).
///
/// `ext` is a lowercase file extension like `"dng"`, `"cr2"`, `"arw"` so
/// rawler can disambiguate formats when magic is ambiguous.
///
/// `xmp` is optional XMP sidecar content as a UTF-8 string (not a path).
#[wasm_bindgen]
pub fn render_bytes(raw: &[u8], ext: &str, xmp: Option<String>) -> Result<MapleRender, JsError> {
    let model = match xmp {
        Some(x) => xmp_mod::parse(&x).map_err(|e| JsError::new(&e.to_string()))?,
        None => xmp_mod::AdjustmentModel::default(),
    };
    let raw_img = raw_core::decode::decode_bytes(raw, ext)
        .map_err(|e| JsError::new(&e.to_string()))?;
    let (w, h, bytes) = raw_core::pipeline::render_from_raw(&raw_img, &model)
        .map_err(|e| JsError::new(&e.to_string()))?;
    Ok(MapleRender { width: w, height: h, rgb: bytes })
}

/// Version string (for build verification from JS).
#[wasm_bindgen]
pub fn version() -> String {
    env!("CARGO_PKG_VERSION").to_string()
}
