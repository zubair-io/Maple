//! Lens falloff for pano ingest (#4516): which source flattened a frame's
//! vignetting before alignment and gain solve, and the bundled-profile
//! fallback for bodies whose DNG carries no gain opcode.
//!
//! An `OpcodeList3` `GainMap` / `FixVignetteRadial` is the vendor's own
//! measurement and stays authoritative. Only when the list has neither does
//! the bundled lens database's vignette run, and only its vignette: the
//! stitcher solves geometry itself, so the profile's distortion and lateral
//! CA terms are deliberately left to the develop path.

use super::opcode_apply::{scale_active_area, LensCorrectionScales};
use super::opcodes::{ActiveAreaRect, OpcodeList3, PanoOpcode};
use crate::{image::Image, lens_profile, RawImage};

/// Which correction removed lens falloff during ingest. Later stages (blind
/// vignette estimation, #4522) only estimate falloff on `None` frames.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum FalloffCorrection {
    None,
    Opcode,
    BundledProfile,
}

const VIGNETTE_ONLY: LensCorrectionScales = LensCorrectionScales {
    distortion: 0.0,
    ca: 0.0,
    vignetting: 1.0,
};

pub(super) fn list_corrects_falloff(list: &OpcodeList3) -> bool {
    list.opcodes.iter().any(|op| {
        matches!(
            op,
            PanoOpcode::GainMap(_) | PanoOpcode::FixVignetteRadial(_)
        )
    })
}

/// Multiply the bundled profile's vignette gain into `image` (demosaiced,
/// pre-DefaultCrop, ActiveArea coordinates). `false` when nothing matched,
/// the profile has no vignette model, or the model fails validation — in
/// which case `image` is untouched.
pub(super) fn apply_bundled_vignette(raw: &RawImage, image: &mut Image) -> bool {
    let Ok(Some(resolution)) = lens_profile::resolve_bundled(raw) else {
        return false;
    };
    if resolution.calibration.vignette.is_none() {
        return false;
    }
    let area = raw
        .lens_metadata
        .active_area
        .unwrap_or(ActiveAreaRect::full(raw.width, raw.height));
    let scaled = scale_active_area(
        area,
        image.width as f32 / raw.width as f32,
        image.width,
        image.height,
    );
    lens_profile::apply(image, &resolution.calibration, scaled, VIGNETTE_ONLY).is_ok()
}
