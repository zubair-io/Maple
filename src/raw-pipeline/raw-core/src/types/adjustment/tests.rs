//! `AdjustmentModel` default-value tests. Split out of the parent
//! `mod.rs` when the #1106 enum push took that file over the 600-LOC
//! hard cap (per CONTRIBUTING.md) — same split as `schema/tests.rs`.

#![cfg(test)]

use super::*;

#[test]
fn defaults_unchanged_for_existing_scalars() {
    let m = AdjustmentModel::default();
    assert_eq!(m.temperature, 6500.0);
    assert_eq!(m.tint, 0.0);
    assert_eq!(m.exposure, 0.0);
    assert_eq!(m.brightness, 0.0);
    assert_eq!(m.contrast, 0.0);
    assert_eq!(m.highlights, 0.0);
    assert_eq!(m.shadows, 0.0);
    assert_eq!(m.whites, 0.0);
    assert_eq!(m.blacks, 0.0);
    // Per-#326 sharpening defaults converge to the reference renderer's
    // fresh-import baseline.
    assert_eq!(m.sharpen_amount, 40.0);
    assert_eq!(m.sharpen_radius, 1.0);
    assert_eq!(m.sharpen_detail, 25.0);
    assert_eq!(m.sharpen_masking, 0.0);
    assert_eq!(m.nr_color, 25.0);
    assert_eq!(
        m.highlight_recovery,
        HighlightRecoveryMode::ChromaticAdaptation
    );
}

#[test]
fn parametric_region_defaults_are_zero() {
    let m = AdjustmentModel::default();
    assert_eq!(m.parametric_highlights, 0.0);
    assert_eq!(m.parametric_lights, 0.0);
    assert_eq!(m.parametric_darks, 0.0);
    assert_eq!(m.parametric_shadows, 0.0);
}

#[test]
fn per_channel_tone_curves_default_to_identity() {
    let m = AdjustmentModel::default();
    assert!(m.tone_curve_luma.is_identity());
    assert!(m.tone_curve_red.is_identity());
    assert!(m.tone_curve_green.is_identity());
    assert!(m.tone_curve_blue.is_identity());
}

#[test]
fn white_balance_preset_default_is_as_shot() {
    assert_eq!(WhiteBalancePreset::default(), WhiteBalancePreset::AsShot);
}

#[test]
fn look_defaults_to_default_variant() {
    // Per ticket #371: new users get the empirical Look, not Neutral.
    let m = AdjustmentModel::default();
    assert_eq!(m.look, Look::Default);
}

#[test]
fn s5_effects_fields_default_to_identity_stubs() {
    // Per ticket #643: vignette / grain / split-tone fields added so
    // the S5 tool pills can wire to the model. Defaults are chosen so
    // the pipeline (which doesn't consume these yet) produces
    // bit-identical output to the pre-#643 baseline.
    let m = AdjustmentModel::default();
    assert_eq!(m.vignette_amount, 0.0);
    assert_eq!(m.vignette_feather, 50.0);
    assert_eq!(m.grain_amount, 0.0);
    assert_eq!(m.grain_size, 25.0);
    assert_eq!(m.grain_roughness, 50.0);
    assert_eq!(m.split_tone_shadow_hue, 0.0);
    assert_eq!(m.split_tone_shadow_saturation, 0.0);
    assert_eq!(m.split_tone_highlight_hue, 0.0);
    assert_eq!(m.split_tone_highlight_saturation, 0.0);
    assert_eq!(m.split_tone_balance, 0.0);
}

#[test]
fn tone_curve_mode_defaults_to_per_channel() {
    // Per ticket #436: `PerChannel` is the pre-existing behavior. The
    // default must keep absent-attribute XMP sidecars byte-identical
    // through the pipeline.
    let m = AdjustmentModel::default();
    assert_eq!(m.tone_curve_mode, ToneCurveMode::PerChannel);
}

#[test]
fn hot_pixel_suppression_defaults_to_off() {
    // Per #1106: pre-demosaic defect suppression ships default-off so
    // the decode product stays bit-identical to the pre-#1106 pipeline.
    let m = AdjustmentModel::default();
    assert_eq!(m.hot_pixel_suppression, HotPixelSuppressionMode::Off);
}

#[test]
fn deep_denoise_defaults_to_zero() {
    // Per #1105: BM3D ships default-off so the decode product stays
    // bit-identical to the pre-#1105 pipeline.
    let m = AdjustmentModel::default();
    assert_eq!(m.deep_denoise, 0.0);
}

#[test]
fn chroma_prefilter_defaults_to_zero() {
    // Per #1104: the decode-time chroma pre-filter ships default-off so
    // the decode product stays bit-identical to the pre-#1104 pipeline
    // (and absent-attribute sidecars round-trip unchanged).
    let m = AdjustmentModel::default();
    assert_eq!(m.chroma_prefilter, 0.0);
}

// ---------------------------------------------------------------------------
// Crop value-type invariants
// ---------------------------------------------------------------------------

#[test]
fn crop_default_is_identity() {
    let c = Crop::default();
    assert_eq!(c, Crop::IDENTITY);
    assert!(c.is_identity(), "Default crop must be the identity");
}

#[test]
fn crop_identity_fields_are_full_frame() {
    let c = Crop::IDENTITY;
    assert_eq!(c.top, 0.0);
    assert_eq!(c.left, 0.0);
    assert_eq!(c.bottom, 1.0);
    assert_eq!(c.right, 1.0);
    assert_eq!(c.angle, 0.0);
}

#[test]
fn crop_non_identity_when_any_edge_or_angle_differs() {
    // Edge-perturbation cases.
    let mut c = Crop::IDENTITY;
    c.top = 0.1;
    assert!(!c.is_identity());

    let mut c = Crop::IDENTITY;
    c.right = 0.9;
    assert!(!c.is_identity());

    // Angle-only perturbation: identity rect with a rotation is still a
    // visible operation (straighten); spec § 3.12 explicitly allows
    // angle-only adjustments.
    let mut c = Crop::IDENTITY;
    c.angle = 0.01;
    assert!(!c.is_identity());
}

#[test]
fn crop_rect_validity_well_formed() {
    let c = Crop {
        top: 0.1,
        left: 0.2,
        bottom: 0.9,
        right: 0.8,
        angle: 0.0,
    };
    assert!(c.rect_is_valid());
}

#[test]
fn crop_rect_validity_inverted_or_empty_is_invalid() {
    // Inverted: bottom < top.
    let c = Crop {
        top: 0.9,
        left: 0.0,
        bottom: 0.1,
        right: 1.0,
        angle: 0.0,
    };
    assert!(!c.rect_is_valid());

    // Empty: right == left.
    let c = Crop {
        top: 0.0,
        left: 0.5,
        bottom: 1.0,
        right: 0.5,
        angle: 0.0,
    };
    assert!(!c.rect_is_valid());
}

#[test]
fn crop_rect_validity_out_of_range_is_invalid() {
    let c = Crop {
        top: -0.1,
        left: 0.0,
        bottom: 1.0,
        right: 1.0,
        angle: 0.0,
    };
    assert!(!c.rect_is_valid());

    let c = Crop {
        top: 0.0,
        left: 0.0,
        bottom: 1.1,
        right: 1.0,
        angle: 0.0,
    };
    assert!(!c.rect_is_valid());
}

#[test]
fn adjustment_default_crop_is_identity() {
    // AdjustmentModel::default() must produce an identity crop so the
    // baseline parity harness stays a no-op for the geometry stage.
    let m = AdjustmentModel::default();
    assert!(m.crop.is_identity());
}
