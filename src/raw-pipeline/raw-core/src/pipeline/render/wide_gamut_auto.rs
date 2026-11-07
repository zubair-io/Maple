//! Display-P3 Auto render that keeps the wide gamut (#4741). The Auto tail is
//! fitted and applied in sRGB-encoded display space, so a P3 render encodes each
//! pixel through `view::encode::rec2020_to_p3_auto_encoded` instead of running
//! the tail on P3-encoded values and the sRGB gamut guard after it.

use crate::{
    image::Image,
    pipeline::stage,
    view::{
        auto_profile::{
            apply::prepared_tail, curve::ProfileCurve, lut::lut_strength_from_env, lut::ColorLut,
        },
        encode::{self, TargetPrimaries},
    },
};

/// The wide-gamut path replaces the sRGB-domain tail whenever an Auto render
/// targets P3; `auto_render` is "profile Auto with a RAW source to fit from".
pub(super) fn engaged(target: TargetPrimaries, auto_render: bool) -> bool {
    auto_render && target == TargetPrimaries::P3
}

/// Encode the `DisplayLinearRec2020` buffer to P3-encoded display values,
/// applying the fitted artifacts (when any) without leaving the P3 gamut. No
/// artifacts is Neutral P3 exactly.
pub(super) fn encode_with_artifacts(
    scene: &mut Image,
    curve: Option<&ProfileCurve>,
    residual: Option<&ColorLut>,
) {
    if curve.is_none() && residual.is_none() {
        encode::rec2020_to_display(scene, TargetPrimaries::P3);
        encode::srgb_gamma_encode(scene);
        return;
    }
    let tail = prepared_tail(
        curve,
        residual.map(|lut| (lut.size, lut.data.as_slice())),
        lut_strength_from_env(),
    );
    encode::rec2020_to_p3_auto_encoded(scene, tail);
}

/// Close the Auto stage on the display buffer: the wide-gamut encode on the P3
/// route, otherwise the hue-preserving gamut guard (#1942). The curve + LUT run
/// in display-encoded space and can push a channel back out of [0, 1] or rotate
/// a saturated colour out of gamut, which the final quantize would hard-clip
/// per channel (the #438/#1621 posterising defect). Inert on in-gamut pixels.
pub(super) fn finish_auto_tail(
    scene: &mut Image,
    wide_gamut: bool,
    curve: Option<&ProfileCurve>,
    residual: Option<&ColorLut>,
) {
    if wide_gamut {
        stage("p3_auto_encode", || {
            encode_with_artifacts(scene, curve, residual)
        });
    } else {
        stage("auto_profile_gamut_guard", || {
            encode::gamut_guard_display_encoded_srgb(scene)
        });
    }
}
