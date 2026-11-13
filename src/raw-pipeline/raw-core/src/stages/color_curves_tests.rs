use super::*;
use crate::color::oklab::{oklab_to_rec2020, rec2020_to_oklab};

#[test]
fn empty_curves_are_bit_identical_identity() {
    let mut img = Image::new(2, 2, ColorSpace::SceneLinearRec2020);
    img.pixels = vec![
        [0.18, 0.18, 0.18],
        [0.50, 0.20, 0.10],
        [0.05, 0.30, 0.60],
        [1.80, 1.20, 0.40],
    ];
    let before = img.pixels.clone();
    let model = AdjustmentModel::default();
    apply_model(&mut img, &model);
    assert_eq!(img.pixels, before);
}

#[test]
fn midline_knots_are_identity() {
    let guard = ToneCurve::new(vec![
        (38.0 / 360.0, 0.5),
        (55.0 / 360.0, 0.5),
        (72.0 / 360.0, 0.5),
    ]);
    let lut = bake_curve_lut(&guard.points, true);
    assert!(lut.is_identity);
}

#[test]
fn neutral_axis_and_sub_gate_pixels_are_untouched() {
    let mut model = AdjustmentModel::default();
    model.color_curve_hue_vs_hue = ToneCurve::new(vec![(0.2, 0.9), (0.7, 0.1)]);
    model.color_curve_hue_vs_sat = ToneCurve::new(vec![(0.3, 1.0)]);
    model.color_curve_luma_vs_sat = ToneCurve::new(vec![(0.0, 1.0), (1.0, 1.0)]);
    let params = ColorCurveParams::from_model(&model);
    assert!(!params.is_identity);

    for v in [0.0, 0.05, 0.18, 0.8, 2.5] {
        let gray = [v, v, v];
        assert_eq!(apply_pixel(gray, &params), gray);
    }

    // Sub-threshold chroma (C = 0.02 < CHROMA_GATE_C0 = 0.05) passes bit-identically.
    let near_neutral = oklab_to_rec2020([0.55, 0.015, 0.010]);
    assert_eq!(apply_pixel(near_neutral, &params), near_neutral);
}

#[test]
fn periodic_hue_spline_is_continuous_across_zero_seam() {
    // Knot near 350 deg raised to 0.85, knot at 180 deg at 0.5.
    let pts = vec![(180.0 / 360.0, 0.5), (350.0 / 360.0, 0.85)];
    let lut = bake_curve_lut(&pts, true);
    let left_of_seam = sample_periodic(&lut, 359.5 / 360.0);
    let right_of_seam = sample_periodic(&lut, 0.5 / 360.0);
    assert!(
        (left_of_seam - right_of_seam).abs() < 0.01,
        "seam discontinuity: left={left_of_seam}, right={right_of_seam}"
    );
    assert!(left_of_seam > 0.25, "expected positive offset near 350 deg");
}

#[test]
fn skin_tone_guard_knots_isolate_skin_from_sky_hue_shift() {
    // Lock skin tone at 38, 55, 72 deg (y = 0.5) and shift blue sky (250 deg) by +30 deg (y = 0.75).
    let curve = ToneCurve::new(vec![
        (38.0 / 360.0, 0.5),
        (55.0 / 360.0, 0.5),
        (72.0 / 360.0, 0.5),
        (160.0 / 360.0, 0.5),
        (250.0 / 360.0, 0.75),
        (330.0 / 360.0, 0.5),
    ]);
    let mut model = AdjustmentModel::default();
    model.color_curve_hue_vs_hue = curve;
    let params = ColorCurveParams::from_model(&model);

    // Skin pixel at 55 deg, C = 0.12, L = 0.65
    let skin_rad = 55.0_f32.to_radians();
    let skin_rgb = oklab_to_rec2020([0.65, 0.12 * skin_rad.cos(), 0.12 * skin_rad.sin()]);
    let skin_out = apply_pixel(skin_rgb, &params);
    let skin_lab_out = rec2020_to_oklab(skin_out);
    let skin_hue_out = oklab_hue_norm(skin_lab_out[1], skin_lab_out[2]) * 360.0;
    assert!(
        (skin_hue_out - 55.0).abs() < 0.1,
        "skin hue shifted: got {skin_hue_out} deg, expected 55.0 deg"
    );

    // Sky pixel at 250 deg, C = 0.12, L = 0.65
    let sky_rad = 250.0_f32.to_radians();
    let sky_rgb = oklab_to_rec2020([0.65, 0.12 * sky_rad.cos(), 0.12 * sky_rad.sin()]);
    let sky_out = apply_pixel(sky_rgb, &params);
    let sky_lab_out = rec2020_to_oklab(sky_out);
    let sky_hue_out = oklab_hue_norm(sky_lab_out[1], sky_lab_out[2]) * 360.0;
    assert!(
        (sky_hue_out - 280.0).abs() < 1.5,
        "sky hue should shift by ~+30 deg to ~280 deg, got {sky_hue_out}"
    );
}

#[test]
fn luma_vs_sat_distinguishes_hdr_highlights_above_diffuse_white() {
    // Desaturate shadows (u_L <= 0.25 -> y = 0.0) while boosting HDR highlights (u_L >= 0.75 -> y = 0.8).
    let mut model = AdjustmentModel::default();
    model.color_curve_luma_vs_sat = ToneCurve::new(vec![
        (0.25, 0.0), // 2 stops below mid-gray (Y = 0.045) -> 0x sat
        (0.50, 0.5), // mid-gray (Y = 0.18) -> 1x sat
        (0.75, 0.8), // 2 stops above mid-gray (Y = 0.72) -> 1.6x sat
    ]);
    let params = ColorCurveParams::from_model(&model);

    // Shadow colored pixel (Y ~ 0.03)
    let shadow_rgb = [0.12, 0.005, 0.001];
    let shadow_input = rec2020_to_oklab(shadow_rgb);
    assert!(shadow_input[1].hypot(shadow_input[2]) >= 2.0 * CHROMA_GATE_C0);
    let shadow_out = apply_pixel(shadow_rgb, &params);
    let shadow_lab = rec2020_to_oklab(shadow_out);
    let shadow_c = (shadow_lab[1].powi(2) + shadow_lab[2].powi(2)).sqrt();
    assert!(shadow_c < 1e-4, "shadow chroma should be 0, got {shadow_c}");

    // Bright highlight pixel (Y ~ 1.2)
    let hi_rgb = [1.6, 1.1, 0.5];
    let hi_in_lab = rec2020_to_oklab(hi_rgb);
    let hi_in_c = (hi_in_lab[1].powi(2) + hi_in_lab[2].powi(2)).sqrt();
    let hi_out = apply_pixel(hi_rgb, &params);
    let hi_out_lab = rec2020_to_oklab(hi_out);
    let hi_out_c = (hi_out_lab[1].powi(2) + hi_out_lab[2].powi(2)).sqrt();
    assert!(
        hi_out_c > hi_in_c * 1.3,
        "highlight chroma should increase: in={hi_in_c}, out={hi_out_c}"
    );
}

#[test]
fn gamut_protection_prevents_negative_rec2020_channels() {
    let mut model = AdjustmentModel::default();
    model.color_curve_hue_vs_sat = ToneCurve::new(vec![(0.0, 1.0)]);
    model.color_curve_sat_vs_sat = ToneCurve::new(vec![(0.0, 1.0), (1.0, 1.0)]);
    model.color_curve_hue_vs_hue = ToneCurve::new(vec![(0.0, 1.0)]);
    let params = ColorCurveParams::from_model(&model);

    for rgb in [
        [0.95, 0.02, 0.01],
        [0.01, 0.90, 0.02],
        [0.02, 0.05, 0.98],
        [1.80, 0.10, 0.05],
    ] {
        let out = apply_pixel(rgb, &params);
        assert!(
            out[0] >= -1e-4 && out[1] >= -1e-4 && out[2] >= -1e-4,
            "negative channel in {out:?} for input {rgb:?}"
        );
    }
}

#[test]
fn xmp_color_curves_round_trip_and_omit_at_default() {
    let default_frag = crate::xmp::serialize_tone_curves(&AdjustmentModel::default(), "  ");
    assert!(!default_frag.contains("ColorCurve"), "{default_frag}");

    let mut model = AdjustmentModel::default();
    model.color_curve_hue_vs_hue = ToneCurve::new(vec![
        (38.0 / 255.0, 128.0 / 255.0),
        (200.0 / 255.0, 180.0 / 255.0),
    ]);
    model.color_curve_luma_vs_sat =
        ToneCurve::new(vec![(0.0, 0.0), (128.0 / 255.0, 128.0 / 255.0), (1.0, 1.0)]);
    let frag = crate::xmp::serialize_tone_curves(&model, "  ");
    assert!(frag.contains("<papp:ColorCurveHueVsHue>"), "{frag}");
    assert!(frag.contains("<papp:ColorCurveLumaVsSat>"), "{frag}");
    assert!(!frag.contains("<papp:ColorCurveHueVsSat>"), "{frag}");

    let xml = format!(
        r#"<?xml version="1.0"?><x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><rdf:Description xmlns:papp="http://ns.justmaple.app/photo/1.0/">{frag}</rdf:Description></rdf:RDF></x:xmpmeta>"#
    );
    let parsed = crate::xmp::parse(&xml).expect("color curve XMP should parse");
    assert_eq!(parsed.color_curve_hue_vs_hue, model.color_curve_hue_vs_hue);
    assert_eq!(
        parsed.color_curve_luma_vs_sat,
        model.color_curve_luma_vs_sat
    );
    assert!(parsed.color_curve_hue_vs_sat.is_identity());
}

#[test]
fn luma_saturation_fades_continuously_through_the_neutral_chroma_gate() {
    let mut model = AdjustmentModel::default();
    model.color_curve_luma_vs_sat = ToneCurve::new(vec![(0.0, 1.0), (1.0, 1.0)]);
    let params = ColorCurveParams::from_model(&model);
    for chroma in [0.0499_f32, 0.0501, 0.06, 0.075, 0.09, 0.10] {
        let rgb = oklab_to_rec2020([0.65, chroma, 0.0]);
        let input = rec2020_to_oklab(rgb);
        let c = input[1].hypot(input[2]);
        // Independent closed-form smoothstep over the specified [C0, 2*C0] interval.
        let t = ((c - 0.05) / 0.05).clamp(0.0, 1.0);
        let expected = c * (1.0 + t * t * (3.0 - 2.0 * t));
        let output = rec2020_to_oklab(apply_pixel(rgb, &params));
        assert!(
            (output[1].hypot(output[2]) - expected).abs() < 1e-5,
            "chroma {c}: expected {expected}, got {:?}",
            output
        );
    }
}

#[test]
fn gamut_shoulder_is_continuous_and_monotonic_across_hull() {
    let input = [1.0, 0.02, 0.03];
    let original = rec2020_to_oklab(input);
    let c_input = original[1].hypot(original[2]);
    let mut previous = c_input;
    for step in 1..=1000 {
        let model = AdjustmentModel {
            color_curve_hue_vs_sat: ToneCurve::new(vec![(0.25, 0.5 + step as f32 * 0.0005)]),
            ..AdjustmentModel::default()
        };
        let output = rec2020_to_oklab(apply_pixel(input, &ColorCurveParams::from_model(&model)));
        let chroma = output[1].hypot(output[2]);
        let delta = chroma - previous;
        assert!(
            delta >= -2e-5 && delta < c_input * 0.0015 + 2e-5,
            "step={step}: chroma {previous} -> {chroma} jumps at the gamut shoulder"
        );
        previous = chroma;
    }
}

#[test]
fn local_identity_preserves_out_of_gamut_pixels_exactly() {
    let input = oklab_to_rec2020([0.6, 0.4, 0.0]);
    assert!(input.iter().any(|value| *value < -0.01));
    let model = AdjustmentModel {
        color_curve_hue_vs_sat: ToneCurve::new(vec![
            (0.0, 0.5),
            (0.3, 0.5),
            (0.5, 0.8),
            (0.7, 0.5),
        ]),
        ..AdjustmentModel::default()
    };
    let params = ColorCurveParams::from_model(&model);
    assert!(!params.is_identity);
    assert_eq!(apply_pixel(input, &params), input);
}

#[test]
fn tiny_hue_and_luma_edits_approach_identity_at_the_hull() {
    let input = [1.0, 0.0, 0.0];
    for kind in 0..2 {
        for y in [0.499999_f32, 0.500001] {
            let curve = ToneCurve::new(vec![(0.25, y)]);
            let model = match kind {
                0 => AdjustmentModel {
                    color_curve_hue_vs_hue: curve,
                    ..AdjustmentModel::default()
                },
                _ => AdjustmentModel {
                    color_curve_hue_vs_luma: curve,
                    ..AdjustmentModel::default()
                },
            };
            let output = apply_pixel(input, &ColorCurveParams::from_model(&model));
            let jump = input
                .iter()
                .zip(output)
                .map(|(a, b)| (a - b).abs())
                .fold(0.0_f32, f32::max);
            assert!(
                jump < 1e-4,
                "kind={kind} y={y}: a tiny edit jumps by {jump}"
            );
        }
    }
}
