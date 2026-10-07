//! Brush dab-series rasterize + register (#360) — the web mirror of
//! raw-ffi's `maple_brush_rasterize`, fused with registration: the worker
//! hands the dab series over, and the bytes `raw_core::rasterize_brush`
//! stamps go straight into the instance registry without ever crossing the
//! JS↔wasm boundary. The render entries then resolve the brush layer's
//! `papp:BrushDigest` through [`crate::mask_registry::resolve_into`] — the
//! same digest loop a `Mask::Bitmap` layer's Vision raster uses.
//!
//! Dab wire: a flat `Float32Array`, [`BRUSH_DAB_STRIDE`] `f32`s per dab —
//! `x, y, radius, feather, weight, erase`, where `erase` is exactly `0` or
//! `1`. Same field order as the `crs:Dabs` XMP series and the C ABI.

use raw_core::types::{rasterize_brush, BrushDab, Point2};
use wasm_bindgen::prelude::*;

use crate::mask_registry;

/// `f32`s per dab on the [`brush_raster_register`] wire.
pub const BRUSH_DAB_STRIDE: usize = 6;

/// Decode the flat dab wire, rasterize it at `width × height`, and register
/// the bytes under `digest`. Returns the raster id the brush layer resolves
/// under. Plain Rust (no JS types) so the host-target tests drive it
/// directly; [`brush_raster_register`] is the `#[wasm_bindgen]` wrapper.
pub(crate) fn register(digest: &str, width: u32, height: u32, wire: &[f32]) -> Result<u32, String> {
    if wire.len() % BRUSH_DAB_STRIDE != 0 {
        return Err(format!(
            "brush_raster_register: dab wire has {} floats, not a multiple of {BRUSH_DAB_STRIDE}",
            wire.len()
        ));
    }
    let mut dabs = Vec::with_capacity(wire.len() / BRUSH_DAB_STRIDE);
    for dab in wire.chunks_exact(BRUSH_DAB_STRIDE) {
        let erase = match dab[5] {
            0.0 => false,
            1.0 => true,
            other => {
                return Err(format!(
                    "brush_raster_register: erase flag must be 0 or 1, got {other}"
                ));
            }
        };
        if ![dab[0], dab[1], dab[2], dab[3], dab[4]]
            .iter()
            .all(|v| v.is_finite())
        {
            return Err("brush_raster_register: dab has a non-finite field".to_string());
        }
        dabs.push(BrushDab::new(
            Point2::new(dab[0], dab[1]),
            dab[2],
            dab[3],
            dab[4],
            erase,
        ));
    }
    let bytes = rasterize_brush(&dabs, width, height);
    mask_registry::register(digest, width, height, &bytes)
}

/// JS entry: see [`register`]. Throws on a malformed digest, a dab wire
/// whose length is not a multiple of six, or a malformed dab.
#[wasm_bindgen]
pub fn brush_raster_register(
    digest: &str,
    width: u32,
    height: u32,
    dabs: &[f32],
) -> Result<u32, JsError> {
    register(digest, width, height, dabs).map_err(|e| JsError::new(&e))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn dab(x: f32, y: f32, radius: f32, feather: f32, weight: f32, erase: f32) -> [f32; 6] {
        [x, y, radius, feather, weight, erase]
    }

    #[test]
    fn register_rasterizes_and_the_bytes_resolve_by_digest() {
        let wire = [
            dab(0.5, 0.5, 0.2, 0.5, 0.6, 0.0),
            dab(0.5, 0.5, 0.2, 0.0, 0.5, 1.0),
        ]
        .concat();
        let id = register("c000100000000360", 51, 51, &wire).expect("register");
        assert!(id >= 1);
        let mut model = raw_core::xmp::AdjustmentModel::default();
        model.local_adjustments = vec![raw_core::types::LocalAdjustment {
            mask: raw_core::types::Mask::Brush {
                dabs: Vec::new(),
                digest: "c000100000000360".into(),
                raster_id: 0,
            },
            range: None,
            adjustments: raw_core::types::PartialAdjustments::default(),
        }];
        mask_registry::resolve_into(&mut model);
        assert_eq!(model.mask_rasters.len(), 1);
        assert_eq!(model.mask_rasters[0].id, id);
        // 0.6 painted, half erased → 0.3, quantized through R8.
        let v = model.mask_rasters[0].data[25 * 51 + 25];
        assert!((v - 77.0 / 255.0).abs() < 1e-6, "centre texel: {v}");
        mask_registry::release(id);
    }

    #[test]
    fn malformed_wires_are_rejected() {
        assert!(register("c000200000000360", 8, 8, &[0.5; 7]).is_err());
        let bad_erase = [dab(0.5, 0.5, 0.1, 0.0, 1.0, 0.7)].concat();
        assert!(register("c000200000000360", 8, 8, &bad_erase).is_err());
        let bad_number = [dab(f32::NAN, 0.5, 0.1, 0.0, 1.0, 0.0)].concat();
        assert!(register("c000200000000360", 8, 8, &bad_number).is_err());
        let good = [dab(0.5, 0.5, 0.1, 0.0, 1.0, 0.0)].concat();
        assert!(register("not-a-digest", 8, 8, &good).is_err());
    }
}
