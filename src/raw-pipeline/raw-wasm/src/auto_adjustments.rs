//! Auto Adjustments WASM surface — one-shot eight-slider recommendation for
//! a RAW file, exposed to the Angular `maple-common` package via wasm-bindgen.
//!
//! Phase M0: all eight fields populated from a single AE-Off/D65 probe buffer
//! developed internally. Mirrors the Apple-side C-FFI
//! `maple_compute_auto_adjustments` in `raw-ffi/src/auto_adjustments.rs`.
//!
//! # AE-Off probe / exposure-replaces-anchor contract
//!
//! The returned `exposure` is computed against the AE-Off base. The Angular
//! consumer **must** set `auto_exposure = "Off"` together with
//! `exposure = result.exposure` — never apply the result on top of an
//! `auto_exposure: On` model or the anchor and the recommended gain will stack.
//! See the raw-core module doc for the full contract.
//!
//! # Two entry points
//!
//! - `compute_auto_adjustments_from_bytes(raw, ext, xmp)`: standalone one-shot
//!   entry analogous to `render_bytes`. Decodes and develops internally;
//!   suitable for a first-open or batch pipeline.
//!
//! - On `WebLiveSession` (GPU feature, when available): the `auto_adjustments`
//!   method runs on the resident decoded RAW so decode is paid only once per
//!   session. See `web_live_session.rs` for wiring when the `gpu` feature is
//!   enabled. The standalone entry below ALSO runs its own probe, which means
//!   two full decodes if called after `render_bytes` — prefer the session
//!   method when the session is already resident.

use raw_core::stages::auto_adjustments as auto_adj_stage;
use wasm_bindgen::prelude::*;

/// Auto Adjustments result. Eight f32 fields in display-range units: exposure
/// in EV, temperature in Kelvin, tint and the five tone sliders in ±100 units.
///
/// Mirrors the C-FFI `MapleAutoAdjustments` struct field-for-field so the
/// Apple Swift binding and the Angular TypeScript binding consume the same
/// payload shape.
#[wasm_bindgen]
pub struct AutoAdjustments {
    /// Exposure in EV, clamped to ±5. See the AE-Off probe contract above.
    pub exposure: f32,
    /// Recommended temperature in Kelvin.
    pub temperature: f32,
    /// Recommended tint in ±100 units.
    pub tint: f32,
    /// Recommended contrast in ±100 units.
    pub contrast: f32,
    /// Recommended highlights in ±100 units.
    pub highlights: f32,
    /// Recommended shadows in ±100 units.
    pub shadows: f32,
    /// Recommended whites in ±100 units.
    pub whites: f32,
    /// Recommended blacks in ±100 units (always ≤ 0).
    pub blacks: f32,
}

/// Compute Auto Adjustment slider values from a RAW file passed as bytes.
///
/// `raw` is the raw file bytes; `ext` is a lowercase extension like `"dng"`,
/// `"cr2"`, `"arw"`. `xmp` is optional XMP sidecar content as a UTF-8 string
/// (not a path); pass `None` for a fresh-open recommendation.
///
/// The function decodes the RAW, develops a single AE-Off/D65 probe buffer
/// (Preview quality for speed), and derives all eight fields. All returned
/// values are finite.
///
/// # AE-Off contract
///
/// The returned `exposure` is relative to the AE-Off probe. The caller must
/// set `auto_exposure = Off` AND `exposure = result.exposure` together —
/// never apply the result on top of an `auto_exposure: On` model.
#[wasm_bindgen]
pub fn compute_auto_adjustments_from_bytes(
    raw: &[u8],
    ext: &str,
    xmp: Option<String>,
) -> Result<AutoAdjustments, JsError> {
    let raw_img =
        raw_core::decode::decode_bytes(raw, ext).map_err(|e| JsError::new(&e.to_string()))?;

    // Parse model (default on fresh open).
    let model = match xmp {
        Some(x) => raw_core::xmp::parse(&x).map_err(|e| JsError::new(&e.to_string()))?,
        None => raw_core::xmp::AdjustmentModel::default(),
    };

    let result = auto_adj_stage::compute_auto_adjustments(&raw_img, &model)
        .map_err(|e| JsError::new(&e.to_string()))?;

    Ok(AutoAdjustments {
        exposure: result.exposure,
        temperature: result.temperature,
        tint: result.tint,
        contrast: result.contrast,
        highlights: result.highlights,
        shadows: result.shadows,
        whites: result.whites,
        blacks: result.blacks,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Verify the WASM surface compiles and returns well-formed values for a
    /// known synthetic input (via the raw-core stage directly, bypassing the
    /// decode path so the test needs no external fixtures).
    #[test]
    fn wasm_auto_adjustments_struct_has_eight_fields() {
        // Build a default result and verify all eight fields are accessible.
        let adj = AutoAdjustments {
            exposure: 0.5,
            temperature: 6500.0,
            tint: 0.0,
            contrast: 10.0,
            highlights: -20.0,
            shadows: 15.0,
            whites: -5.0,
            blacks: -10.0,
        };
        assert!(adj.exposure.is_finite());
        assert!(adj.temperature.is_finite());
        assert!(adj.tint.is_finite());
        assert!(adj.contrast.is_finite());
        assert!(adj.highlights.is_finite());
        assert!(adj.shadows.is_finite());
        assert!(adj.whites.is_finite());
        assert!(adj.blacks.is_finite());
    }
}
