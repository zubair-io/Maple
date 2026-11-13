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
use crate::{image::Image, lens_profile, lens_profile::model::Calibration, RawImage};

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
    let full_height = image.height;
    bundled_vignette(raw).is_some_and(|calibration| {
        apply_vignette_windowed(raw, &calibration, image, 0, full_height)
    })
}

/// The bundled profile's calibration when one matches `raw` and models
/// vignetting.
pub(super) fn bundled_vignette(raw: &RawImage) -> Option<Calibration> {
    lens_profile::resolve_bundled(raw)
        .ok()
        .flatten()
        .map(|resolution| resolution.calibration)
        .filter(|calibration| calibration.vignette.is_some())
}

/// The vignette half of `calibration` on a full-width row band whose top row
/// sits at absolute row `origin_y` of a `full_height`-row frame (#5552).
/// `false` when the model fails validation, leaving `image` untouched.
pub(super) fn apply_vignette_windowed(
    raw: &RawImage,
    calibration: &Calibration,
    image: &mut Image,
    origin_y: u32,
    full_height: u32,
) -> bool {
    let area = raw
        .lens_metadata
        .active_area
        .unwrap_or(ActiveAreaRect::full(raw.width, raw.height));
    let scaled = scale_active_area(
        area,
        image.width as f32 / raw.width as f32,
        image.width,
        full_height,
    );
    lens_profile::apply_windowed(
        image,
        calibration,
        scaled,
        VIGNETTE_ONLY,
        (0, origin_y),
        (image.width, full_height),
    )
    .is_ok()
}
