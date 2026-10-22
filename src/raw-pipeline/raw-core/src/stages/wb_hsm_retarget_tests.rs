use super::*;
use crate::color::dcp::{self, HsmEndpoints};
use crate::color::hsm::HsmTable;

/// Two smooth, clearly different HueSatMaps over a 6×4×`val_divs` lattice:
/// hue shifts of several degrees and saturation and value scales away from 1
/// that vary across the lattice (value too, when it has an axis), so a delta
/// that ignored the table, or read it at the wrong brightness, would miss.
fn endpoint_tables_shaped(val_divs: u32, encoding: HsmEncoding) -> (HsmTable, HsmTable) {
    let table = |phase: f32, hue_amp: f32, sat_amp: f32| {
        let data = (0..6)
            .flat_map(|h| (0..4).flat_map(move |s| (0..val_divs).map(move |v| (h, s, v))))
            .flat_map(|(h, s, v)| {
                let angle = h as f32 / 6.0 * std::f32::consts::TAU + phase;
                let sat = s as f32 / 3.0;
                let val = v as f32 / (val_divs - 1).max(1) as f32;
                [
                    hue_amp * angle.sin() * sat * (1.0 + val),
                    1.0 + sat_amp * angle.cos() * sat * (1.0 - 0.5 * val),
                    1.0 - 0.04 * angle.sin() * sat + 0.03 * val,
                ]
            })
            .collect();
        HsmTable::new([6, 4, val_divs], data, encoding).unwrap()
    };
    (table(0.0, 8.0, 0.15), table(1.3, -6.0, -0.1))
}

fn endpoint_tables() -> (HsmTable, HsmTable) {
    endpoint_tables_shaped(1, HsmEncoding::Linear)
}

#[cfg(feature = "test-support")]
fn chart_with_dual_hsm() -> (crate::image::RawImage, DcpProfile) {
    chart_with_tables(endpoint_tables())
}

#[cfg(feature = "test-support")]
fn chart_with_tables(tables: (HsmTable, HsmTable)) -> (crate::image::RawImage, DcpProfile) {
    use crate::test_support::synth_chart::{ChartEncoding, SyntheticColorChart};
    let bytes = SyntheticColorChart {
        encoding: ChartEncoding::Camera,
        ..SyntheticColorChart::default()
    }
    .write_to_bytes();
    let raw = crate::decode::decode_bytes(&bytes, "dng").expect("synthetic chart");
    let profile = dcp::profile_for(&raw).expect("chart profile");
    let e = profile.cm_endpoints.expect("dual calibration");
    assert!(
        profile.forward_matrix.is_some(),
        "chart profile must carry an FM"
    );
    let (cold, warm) = tables;
    let hsm = dcp::lerp_hsm_for_cct(
        Some(&cold),
        Some(&warm),
        e.cct_cold,
        e.cct_warm,
        profile.scene_cct,
    );
    let profile = DcpProfile {
        hsm,
        hsm_endpoints: Some(std::sync::Arc::new(HsmEndpoints { cold, warm })),
        ..profile
    };
    (raw, profile)
}

/// A deterministic spread of white-balanced camera readings, saturated and
/// neutral, across two decades of exposure.
fn camera_pixels() -> Image {
    let mut img = Image::new(32, 32, ColorSpace::CameraNativeLinearRgb);
    let mut state = 0x2545_f491_u32;
    let mut next = || {
        state ^= state << 13;
        state ^= state >> 17;
        state ^= state << 5;
        (state % 10_000) as f32 / 10_000.0
    };
    for p in &mut img.pixels {
        let level = 0.01 + 0.9 * next();
        *p = [
            level * (0.1 + next()),
            level * (0.1 + next()),
            level * (0.1 + next()),
        ];
    }
    img
}

fn max_abs(a: &Image, b: &Image) -> f32 {
    a.pixels
        .iter()
        .zip(&b.pixels)
        .flat_map(|(p, q)| (0..3).map(move |c| (p[c] - q[c]).abs()))
        .fold(0.0, f32::max)
}

fn scaled_image(img: &Image, gain: f32) -> Image {
    Image {
        pixels: img.pixels.iter().map(|p| p.map(|v| v * gain)).collect(),
        ..img.clone()
    }
}

/// The fixture-free form of the #5099 contract: a live drag over an
/// as-shot develop lands on a fresh develop at the target, HueSatMap
/// included, while the plain 3×3 delta visibly misses it. Covered for a 2D
/// linear table, a table with a value axis, and an sRGB-encoded one, each
/// with the decode's auto exposure applied after DCP, which only the 2D
/// linear table is blind to.
#[cfg(feature = "test-support")]
#[test]
fn live_delta_with_hsm_matches_a_retargeted_develop() {
    use crate::stages::wb_camera::{self, retargeted_render_profile, SliderFrame};
    let shapes = [
        ("2D linear", 1, HsmEncoding::Linear),
        ("3D linear", 5, HsmEncoding::Linear),
        ("3D sRGB", 5, HsmEncoding::Srgb),
    ];
    for (shape, val_divs, encoding) in shapes {
        let (raw, profile) = chart_with_tables(endpoint_tables_shaped(val_divs, encoding));
        let frame = SliderFrame::resolve(&raw, &profile);
        let export = SliderFrameExport::resolve(&raw, &profile);
        let retarget = WbHsmRetarget::resolve(&profile).expect("dual HSM + FM profile");
        let anchor = (export.scene_cct, export.as_shot_tint);
        let camera = camera_pixels();
        for gain in [1.0, 2.7] {
            let bake = scaled_image(&dcp::apply_colorimetry(&camera, &profile).unwrap(), gain);
            for target in [
                (anchor.0 + 600.0, anchor.1 + 10.0),
                (anchor.0 - 900.0, anchor.1 - 12.0),
                (2000.0, 0.0),
                (2850.0, 0.0),
                (12000.0, 30.0),
            ] {
                let mut shifted = camera.clone();
                wb_camera::apply_delta(&mut shifted, &frame, raw.as_shot_neutral, target, anchor);
                let develop = scaled_image(
                    &dcp::apply_colorimetry(
                        &shifted,
                        &retargeted_render_profile(&frame, profile.clone(), target.0, target.1),
                    )
                    .unwrap(),
                    gain,
                );
                let mut plain = bake.clone();
                export.apply_delta_rec2020(&mut plain, target, anchor);
                let mut live = bake.clone();
                export.apply_delta_rec2020_with_hsm(
                    &mut live,
                    target,
                    anchor,
                    Some(retarget.view(gain)),
                );
                let view = retarget.view(gain);
                let tick = view
                    .live_delta(
                        &export,
                        export.rec2020_delta_matrix(target, anchor),
                        target,
                        anchor,
                    )
                    .unwrap();
                let mut converged = bake.clone();
                view.apply_image(
                    &HsmLiveDelta {
                        inverse_iterations: 12,
                        ..tick
                    },
                    &mut converged,
                );
                let err_plain = max_abs(&plain, &develop) / gain;
                let err_live = max_abs(&live, &develop) / gain;
                let err_converged = max_abs(&converged, &develop) / gain;
                eprintln!(
                    "{shape} gain {gain} {target:?}: plain 3x3 {err_plain:.2e}, with HSM \
                     {err_live:.2e}, converged {err_converged:.2e}"
                );
                assert!(
                    err_plain > 5e-3,
                    "{shape} {target:?}: the case must exercise the table"
                );
                assert!(
                    err_converged < 1e-5,
                    "{shape} gain {gain} {target:?}: the composition itself is off ({err_converged:.2e})"
                );
                let ceiling = if val_divs == 1 { 2e-4 } else { 2e-3 };
                assert!(
                    err_live < ceiling && err_live < err_plain / 10.0,
                    "{shape} gain {gain} {target:?}: live-with-HSM {err_live:.2e} vs a fresh develop"
                );
            }
        }
    }
}

/// Ignoring the exposure gain is measurably wrong on a table with a value
/// axis, so the test above is not passing by the gain being inert.
#[cfg(feature = "test-support")]
#[test]
fn exposure_gain_matters_for_a_table_with_a_value_axis() {
    use crate::stages::wb_camera::{self, retargeted_render_profile, SliderFrame};
    let (raw, profile) = chart_with_tables(endpoint_tables_shaped(5, HsmEncoding::Srgb));
    let frame = SliderFrame::resolve(&raw, &profile);
    let export = SliderFrameExport::resolve(&raw, &profile);
    let retarget = WbHsmRetarget::resolve(&profile).unwrap();
    let anchor = (export.scene_cct, export.as_shot_tint);
    let target = (2850.0, 0.0);
    let gain = 2.7;
    let camera = camera_pixels();
    let bake = scaled_image(&dcp::apply_colorimetry(&camera, &profile).unwrap(), gain);
    let mut shifted = camera.clone();
    wb_camera::apply_delta(&mut shifted, &frame, raw.as_shot_neutral, target, anchor);
    let develop = scaled_image(
        &dcp::apply_colorimetry(
            &shifted,
            &retargeted_render_profile(&frame, profile.clone(), target.0, target.1),
        )
        .unwrap(),
        gain,
    );
    let mut unscaled = bake.clone();
    export.apply_delta_rec2020_with_hsm(&mut unscaled, target, anchor, Some(retarget.view(1.0)));
    assert!(max_abs(&unscaled, &develop) / gain > 1e-3);
}

#[cfg(feature = "test-support")]
#[test]
fn identity_band_and_absent_tables_keep_the_existing_paths() {
    let (raw, profile) = chart_with_dual_hsm();
    let export = SliderFrameExport::resolve(&raw, &profile);
    let retarget = WbHsmRetarget::resolve(&profile).unwrap();
    let anchor = (export.scene_cct, export.as_shot_tint);
    let bake = dcp::apply_colorimetry(&camera_pixels(), &profile).unwrap();

    let near = (anchor.0 + 0.3, anchor.1 - 0.3);
    let mut live = bake.clone();
    export.apply_delta_rec2020_with_hsm(&mut live, near, anchor, Some(retarget.view(1.0)));
    assert_eq!(live.pixels, bake.pixels, "identity band is bit-exact");

    let target = (anchor.0 + 700.0, anchor.1);
    let mut without = bake.clone();
    export.apply_delta_rec2020_with_hsm(&mut without, target, anchor, None);
    let mut plain = bake.clone();
    export.apply_delta_rec2020(&mut plain, target, anchor);
    assert_eq!(without.pixels, plain.pixels, "no tables is the plain 3x3");
}

#[cfg(feature = "test-support")]
#[test]
fn resolve_follows_when_a_retarget_moves_the_table() {
    let (_, profile) = chart_with_dual_hsm();
    assert!(WbHsmRetarget::resolve(&profile).is_some());
    let no_endpoints = DcpProfile {
        hsm_endpoints: None,
        ..profile.clone()
    };
    assert!(WbHsmRetarget::resolve(&no_endpoints).is_none());
    let bradford = DcpProfile {
        forward_matrix: None,
        cm_endpoints: profile.cm_endpoints.map(|e| dcp::CmEndpoints {
            fm_cold: None,
            fm_warm: None,
            ..e
        }),
        ..profile.clone()
    };
    assert!(
        WbHsmRetarget::resolve(&bradford).is_none(),
        "the non-FM Bradford path holds its HueSatMap"
    );
    let (cold, _) = endpoint_tables();
    let mismatched = HsmTable::new(
        [3, 4, 1],
        vec![0.0, 1.0, 1.0].repeat(12),
        HsmEncoding::Linear,
    )
    .unwrap();
    let mismatch = DcpProfile {
        hsm_endpoints: Some(std::sync::Arc::new(HsmEndpoints {
            cold,
            warm: mismatched,
        })),
        ..profile
    };
    assert!(WbHsmRetarget::resolve(&mismatch).is_none());
}

fn wire(cold: &HsmTable, warm: &HsmTable) -> Vec<f32> {
    [6.0, 4.0, 1.0, 0.0, 2856.0, 6504.0]
        .iter()
        .chain(&cold.data)
        .chain(&warm.data)
        .copied()
        .collect()
}

#[test]
fn wire_round_trips_and_rejects_malformed_input() {
    let (cold, warm) = endpoint_tables();
    let wire = wire(&cold, &warm);
    let view = HsmRetargetView::from_wire(&wire, 4100.0, 2.0).expect("valid wire");
    assert_eq!(view.dims, [6, 4, 1]);
    assert_eq!(view.cold_warm(), (&cold.data[..], &warm.data[..]));
    assert_eq!(
        (
            view.cct_cold,
            view.cct_warm,
            view.as_shot_cct,
            view.exposure_gain
        ),
        (2856.0, 6504.0, 4100.0, 2.0)
    );
    for stale_gain in [0.0, -1.0, f32::NAN] {
        assert_eq!(
            HsmRetargetView::from_wire(&wire, 4100.0, stale_gain)
                .unwrap()
                .exposure_gain,
            1.0
        );
    }

    assert!(HsmRetargetView::from_wire(&[], 4100.0, 1.0).is_none());
    assert!(HsmRetargetView::from_wire(&wire[..wire.len() - 1], 4100.0, 1.0).is_none());
    assert!(HsmRetargetView::from_wire(&wire, 0.0, 1.0).is_none());
    assert!(HsmRetargetView::from_wire(&wire, f32::NAN, 1.0).is_none());
    for (index, bad) in [
        (0, 0.0),
        (1, 2.5),
        (2, 5000.0),
        (3, 2.0),
        (4, -1.0),
        (5, f32::NAN),
    ] {
        let mut broken = wire.clone();
        broken[index] = bad;
        assert!(
            HsmRetargetView::from_wire(&broken, 4100.0, 1.0).is_none(),
            "header[{index}] = {bad}"
        );
    }
    let huge = [4096.0, 4096.0, 4096.0, 0.0, 2856.0, 6504.0];
    assert!(HsmRetargetView::from_wire(&huge, 4100.0, 1.0).is_none());
}

#[test]
fn the_wire_depends_on_the_profile_only() {
    let (cold, warm) = endpoint_tables();
    let profile_at = |scene_cct: f32| DcpProfile {
        hsm_endpoints: Some(std::sync::Arc::new(HsmEndpoints {
            cold: cold.clone(),
            warm: warm.clone(),
        })),
        forward_matrix: Some(crate::math::Matrix3::IDENTITY),
        scene_cct,
        cm_endpoints: Some(dcp::CmEndpoints {
            m_cold: crate::math::Matrix3::IDENTITY,
            cct_cold: 2856.0,
            m_warm: crate::math::Matrix3::IDENTITY,
            cct_warm: 6504.0,
            fm_cold: Some(crate::math::Matrix3::IDENTITY),
            fm_warm: Some(crate::math::Matrix3::IDENTITY),
        }),
        ..DcpProfile::from_embedded_cm(crate::math::Matrix3::IDENTITY)
    };
    let (a, b) = (
        WbHsmRetarget::resolve(&profile_at(3900.0)).unwrap(),
        WbHsmRetarget::resolve(&profile_at(5200.0)).unwrap(),
    );
    assert_eq!(a.wire(), b.wire());
    assert_eq!((a.as_shot_cct(), b.as_shot_cct()), (3900.0, 5200.0));
    let with_look = DcpProfile {
        look_table: Some(cold.clone()),
        ..profile_at(3900.0)
    };
    assert!(
        WbHsmRetarget::resolve(&with_look).is_none(),
        "a LookTable keeps the 3x3"
    );
}

#[test]
fn blended_lookup_matches_the_develops_lerped_table() {
    let (cold, warm) = endpoint_tables();
    for t in [0.0, 0.25, 0.6, 1.0] {
        let lerped = crate::color::hsm::lerp_tables(&cold, &warm, t).unwrap();
        for rgb in [
            [0.8, 0.2, 0.1],
            [0.1, 0.5, 0.9],
            [0.3, 0.3, 0.31],
            [0.05, 0.9, 0.4],
            [-0.02, 0.4, 0.6],
        ] {
            let want = crate::color::hsm::apply_one(rgb, &lerped);
            let got = crate::color::hsm::apply_one_blended(
                rgb,
                cold.dims,
                cold.encoding,
                (&cold.data, &warm.data),
                t,
            );
            for c in 0..3 {
                assert!(
                    (got[c] - want[c]).abs() < 1e-5,
                    "t {t} {rgb:?}: {got:?} vs {want:?}"
                );
            }
        }
    }
}

#[test]
fn weight_matches_the_reciprocal_cct_lerp() {
    let (cold, warm) = endpoint_tables();
    let wire = wire(&cold, &warm);
    let view = HsmRetargetView::from_wire(&wire, 4100.0, 1.0).unwrap();
    assert_eq!(view.weight_at(2000.0), 0.0);
    assert_eq!(view.weight_at(9000.0), 1.0);
    let cct = 4100.0;
    let lerped = dcp::lerp_hsm_for_cct(Some(&cold), Some(&warm), 2856.0, 6504.0, cct).unwrap();
    let blended = crate::color::hsm::lerp_tables(&cold, &warm, view.weight_at(cct)).unwrap();
    assert_eq!(lerped.data, blended.data);
}

#[test]
fn blended_lookup_matches_develop_when_endpoint_and_spatial_unwrap_branches_differ() {
    use crate::color::hsm::{apply_one, apply_one_blended, hsv_to_rgb, lerp_tables};
    let table = |hues: [f32; 2]| {
        HsmTable::new(
            [2, 2, 1],
            hues.into_iter()
                .flat_map(|h| [[h, 1.0, 1.0]; 2].into_iter().flatten())
                .collect(),
            HsmEncoding::Linear,
        )
        .unwrap()
    };
    let cold = table([-70.0, -126.0]);
    let warm = table([158.0, 45.0]);
    for t in [0.0, 0.25, 0.5, 0.75, 1.0] {
        let blended = lerp_tables(&cold, &warm, t).unwrap();
        for hue in [15.0, 45.0, 90.0, 135.0, 210.0, 315.0] {
            for sat in [0.005, 0.05, 0.5, 1.0] {
                let rgb = hsv_to_rgb(hue, sat, 0.8);
                let want = apply_one(rgb, &blended);
                let got =
                    apply_one_blended(rgb, cold.dims, cold.encoding, (&cold.data, &warm.data), t);
                for c in 0..3 {
                    assert!(
                        (got[c] - want[c]).abs() < 1e-6,
                        "t={t}, hue={hue}, sat={sat}: {got:?} vs {want:?}"
                    );
                }
            }
        }
    }
}
