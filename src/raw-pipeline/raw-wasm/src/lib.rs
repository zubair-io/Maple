//! wasm-bindgen surface for raw-core. Intended for consumption by the
//! Angular web workspace's `Maple-common` package (per spec § 00).
//!
//! Minimal v1 surface:
//!
//!   render_from_bytes(raw: Uint8Array, ext: string, xmp: string | null)
//!       → { width: u32, height: u32, rgb: Uint8Array }
//!
//! Unlike the FFI surface (path-based), this takes the RAW as a byte
//! buffer because WASM has no filesystem. Callers must write the bytes
//! to a temp file before calling render — not ideal, but raw-core's
//! `decode::decode` takes a path. A future slice can refactor decode
//! to accept a reader trait.

use raw_core::{render, xmp};
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

/// Render a RAW at `raw_path` with optional XMP at `xmp_path`. Returns
/// a MapleRender struct with width/height/rgb.
///
/// **Temporary**: takes paths (not buffers) because raw-core's decoder is
/// path-based. A future slice should add a reader-trait decode path so the
/// web caller can pass bytes directly.
#[wasm_bindgen]
pub fn render_file(raw_path: &str, xmp_path: Option<String>) -> Result<MapleRender, JsError> {
    let model = match xmp_path {
        Some(p) => {
            let xml = std::fs::read_to_string(&p).map_err(|e| JsError::new(&e.to_string()))?;
            xmp::parse(&xml).map_err(|e| JsError::new(&e.to_string()))?
        }
        None => xmp::AdjustmentModel::default(),
    };
    let (w, h, bytes) = render(std::path::Path::new(raw_path), &model)
        .map_err(|e| JsError::new(&e.to_string()))?;
    Ok(MapleRender { width: w, height: h, rgb: bytes })
}

/// Version string (for build verification from JS).
#[wasm_bindgen]
pub fn version() -> String {
    env!("CARGO_PKG_VERSION").to_string()
}
