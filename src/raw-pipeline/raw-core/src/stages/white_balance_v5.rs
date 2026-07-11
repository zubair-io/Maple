//! The V5 (#1894) Robertson slider-value mapping + the legacy-to-V5
//! authored-pair conversion. Split from `white_balance.rs` to keep that
//! file under the 600-line hard budget (CONTRIBUTING.md § "File-size
//! budget") — same `#[path]` sibling pattern as `wb_camera_scale.rs` /
//! `wb_frame_delta.rs`. Pure code move: no logic change from what landed
//! in `white_balance.rs` as part of the #1894 groundwork.

use super::{cct_to_xy, apply_tint_perpendicular, TINT_SCALE_V3_TO_V4};

/// Slider `(temperature, tint)` → source chromaticity xy — the ACR value
/// mapping (#1894): Robertson isotherms via [`crate::color::dng_temperature`],
/// so a slider pair means EXACTLY what ACR's displayed pair means, in both
/// directions. Every live forward path ([`super::wb_gains`],
/// [`super::wb_cat16_matrix`], `wb_camera::target_xyz`) and the as-shot
/// estimator's inverse derive from this one mapping, keeping the
/// estimator/render inverse invariant (#1870) by construction.
pub(crate) fn slider_source_xy(temperature: f32, tint: f32) -> (f32, f32) {
    crate::color::dng_temperature::temp_tint_to_xy(temperature, tint)
}

/// The pre-#1894 (≤ V4) forward map — Hernández-Andrés daylight locus +
/// perpendicular uv displacement at the version's tint magnitude. Kept
/// ONLY so values authored under the legacy scales can be re-expressed
/// through the physical chromaticity they encoded
/// ([`authored_pair_to_v5`]); no live path derives new values from it.
pub(crate) fn legacy_slider_source_xy(temperature: f32, tint: f32) -> (f32, f32) {
    let (x, y) = cct_to_xy(temperature);
    apply_tint_perpendicular(x, y, temperature, tint, true)
}

/// Re-express an explicitly-authored `(temperature, tint)` pair in the
/// current (V5, #1894) Robertson value mapping, preserving the physical
/// chromaticity it encoded when written:
///
/// - **V1/V3** — ACR-direction axis at the legacy 1e-4 uv-per-unit scale:
///   rescale the tint by [`super::TINT_SCALE_V3_TO_V4`] (0.3), evaluate the
///   legacy (Hernández-Andrés + perpendicular) map, invert through
///   Robertson.
/// - **V2** — the inverted-axis legacy scale: negate AND rescale, then the
///   same xy round-trip.
/// - **V4** — ACR magnitude but the legacy locus map (#1893, never in a
///   released build): straight xy round-trip.
/// - **V5** — Robertson-native: passes through.
///
/// The conversion transforms the PAIR jointly — the legacy map's locus is
/// the daylight locus while Robertson's is blackbody, so even a
/// temperature-only authored value moves slightly in both components
/// (e.g. legacy (6500, 0) reads back ≈ (6470, +10) — the same physical
/// chromaticity, named in ACR's coordinates).
///
/// Shared by [`super::resolve_wb`] (the post-DCP CAT16/diagonal fallback
/// tier) and `wb_camera::resolve_target_versioned` (the camera-space
/// tiers) so the two resolvers cannot drift.
pub(crate) fn authored_pair_to_v5(
    temperature: f32,
    tint: f32,
    version: crate::xmp::WbScaleVersion,
) -> (f32, f32) {
    use crate::xmp::WbScaleVersion as V;
    let legacy_tint = match version {
        V::V1 | V::V3 => tint * TINT_SCALE_V3_TO_V4,
        V::V2 => -tint * TINT_SCALE_V3_TO_V4,
        V::V4 => tint,
        V::V5 => return (temperature, tint),
    };
    let (x, y) = legacy_slider_source_xy(temperature, legacy_tint);
    crate::color::dng_temperature::xy_to_temp_tint(x, y)
}
