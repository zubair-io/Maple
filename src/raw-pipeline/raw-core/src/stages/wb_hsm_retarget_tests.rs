use super::*;
use crate::color::dcp::{self, HsmEndpoints};
use crate::color::hsm::HsmTable;

/// Two smooth, clearly different HueSatMaps over a 6×4×1 lattice: hue
/// shifts of several degrees and saturation scales away from 1 that vary
/// across the lattice, so a delta that ignored the table would miss.
fn endpoint_tables() -> (HsmTable, HsmTable) {
    let table = |phase: f32, hue_amp: f32, sat_amp: f32| {
        let data = (0..6)
            .flat_map(|h| (0..4).map(move |s| (h, s)))
            .flat_map(|(h, s)| {
                let angle = h as f32 / 6.0 * std::f32::consts::TAU + phase;
                let sat = s as f32 / 3.0;
                [
                    hue_amp * angle.sin() * sat,
                    1.0 + sat_amp * angle.cos() * sat,
                    1.0 - 0.04 * angle.sin() * sat,
                ]
            })
            .collect();
        HsmTable::new([6, 4, 1], data, HsmEncoding::Linear).unwrap()
    };
    (table(0.0, 8.0, 0.15), table(1.3, -6.0, -0.1))
}

#[cfg(feature = "test-support")]
fn chart_with_dual_hsm() -> (crate::image::RawImage, DcpProfile) {
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
    let (cold, warm) = endpoint_tables();
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

/// The fixture-free form of the #5099 contract: a live drag over an
/// as-shot develop lands on a fresh develop at the target, HueSatMap
/// included, while the plain 3×3 delta visibly misses it.
#[cfg(feature = "test-support")]
#[test]
fn live_delta_with_hsm_matches_a_retargeted_develop() {
    use crate::stages::wb_camera::{self, retargeted_render_profile, SliderFrame};
    let (raw, profile) = chart_with_dual_hsm();
    let frame = SliderFrame::resolve(&raw, &profile);
    let export = SliderFrameExport::resolve(&raw, &profile);
    let retarget = WbHsmRetarget::resolve(&profile).expect("dual HSM + FM profile");
    let anchor = (export.scene_cct, export.as_shot_tint);
    let camera = camera_pixels();
    let bake = dcp::apply_colorimetry(&camera, &profile).unwrap();

    for target in [
        (anchor.0 + 600.0, anchor.1 + 10.0),
        (anchor.0 - 900.0, anchor.1 - 12.0),
        (2000.0, 0.0),
        (2850.0, 0.0),
        (12000.0, 30.0),
    ] {
        let mut shifted = camera.clone();
        wb_camera::apply_delta(&mut shifted, &frame, raw.as_shot_neutral, target, anchor);
        let develop = dcp::apply_colorimetry(
            &shifted,
            &retargeted_render_profile(&frame, profile.clone(), target.0, target.1),
        )
        .unwrap();

        let mut plain = bake.clone();
        export.apply_delta_rec2020(&mut plain, target, anchor);
        let mut live = bake.clone();
        export.apply_delta_rec2020_with_hsm(&mut live, target, anchor, Some(retarget.view()));

        let (err_plain, err_live) = (max_abs(&plain, &develop), max_abs(&live, &develop));
        eprintln!("{target:?}: plain 3x3 max {err_plain:.2e}, with HSM max {err_live:.2e}");
        assert!(
            err_plain > 5e-3,
            "{target:?}: the case must exercise the table"
        );
        assert!(
            err_live < 2e-4,
            "{target:?}: live-with-HSM max abs {err_live:.2e} vs a fresh develop"
        );
    }
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
    export.apply_delta_rec2020_with_hsm(&mut live, near, anchor, Some(retarget.view()));
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

#[test]
fn flat_wire_round_trips_and_rejects_malformed_headers() {
    let (cold, warm) = endpoint_tables();
    let header = [6.0, 4.0, 1.0, 0.0, 2856.0, 6504.0, 4100.0];
    let flat: Vec<f32> = header
        .iter()
        .chain(&cold.data)
        .chain(&warm.data)
        .copied()
        .collect();
    let view = HsmRetargetView::from_flat(&flat).expect("valid wire");
    assert_eq!(view.dims, [6, 4, 1]);
    assert_eq!(view.cold, &cold.data[..]);
    assert_eq!(view.warm, &warm.data[..]);
    assert_eq!(
        (view.cct_cold, view.cct_warm, view.as_shot_cct),
        (2856.0, 6504.0, 4100.0)
    );

    assert!(HsmRetargetView::from_flat(&[]).is_none());
    assert!(HsmRetargetView::from_flat(&flat[..flat.len() - 1]).is_none());
    for (index, bad) in [(0, 0.0), (1, 2.5), (3, 2.0), (4, -1.0), (6, f32::NAN)] {
        let mut broken = flat.clone();
        broken[index] = bad;
        assert!(
            HsmRetargetView::from_flat(&broken).is_none(),
            "header[{index}] = {bad}"
        );
    }
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
    let mut flat = vec![6.0, 4.0, 1.0, 0.0, 2856.0, 6504.0, 4100.0];
    flat.extend(&cold.data);
    flat.extend(&warm.data);
    let view = HsmRetargetView::from_flat(&flat).unwrap();
    assert_eq!(view.weight_at(2000.0), 0.0);
    assert_eq!(view.weight_at(9000.0), 1.0);
    let cct = 4100.0;
    let lerped = dcp::lerp_hsm_for_cct(Some(&cold), Some(&warm), 2856.0, 6504.0, cct).unwrap();
    let blended = crate::color::hsm::lerp_tables(&cold, &warm, view.weight_at(cct)).unwrap();
    assert_eq!(lerped.data, blended.data);
}
