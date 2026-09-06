//! Unit tests for [`super`] — the auto white balance estimate (#2247).
//!
//! Two families. The generic-tier tests (no calibration matrix on the
//! synthetic `RawImage`, so `dcp::profile_for` lands on `RawlerFallback`)
//! exercise the gates and the blend on hand-built probe buffers, the way
//! the original `auto_adjustments_tests.rs` did. The calibrated-tier tests
//! build a real Bayer `RawImage` with an embedded ColorMatrix and run the
//! WHOLE `compute_auto_adjustments` path, so the probe-space mirror of the
//! develop chain and the slider-frame solve are checked against the chain
//! itself rather than against a copy of it.

use super::*;
use crate::color::illuminant::Illuminant;
use crate::stages::auto_adjustments::compute_auto_adjustments;

fn flat_image(r: f32, g: f32, b: f32) -> Image {
    let mut img = Image::new(128, 128, ColorSpace::SceneLinearRec2020);
    for px in &mut img.pixels {
        *px = [r, g, b];
    }
    img
}

/// Minimal synthetic `RawImage` — no embedded color matrix, so
/// `dcp::profile_for` takes the rawler-fallback tier and the estimator
/// judges pixels in the probe's own Rec.2020 (the generic tier).
fn make_raw(as_shot_neutral: [f32; 3]) -> RawImage {
    RawImage {
        width: 1,
        height: 1,
        cfa: CfaPattern::Rggb,
        black_level: [0; 4],
        white_level: 1,
        raw_data: vec![0],
        as_shot_neutral,
        as_shot_cct: None,
        camera_make: "Test".into(),
        camera_model: "Test".into(),
        unique_camera_model: None,
        color_matrices: std::collections::HashMap::new(),
        forward_matrices: std::collections::HashMap::new(),
        orientation: crate::image::ExifOrientation::Normal,
        baseline_exposure: 0.0,
        hsm_data: std::collections::HashMap::new(),
        plt: None,
        profile_tone_curve: None,
        profile_gain_table_map: None,
        crop_rect: None,
        iso: 100,
        noise_profile: None,
        opcode_list3: None,
        aperture: None,
        focal_length: None,
        lens_metadata: Default::default(),
    }
}

fn probe_model() -> AdjustmentModel {
    AdjustmentModel::default()
}

/// G-normalised chromaticity of the whole image — the gray-world answer when
/// every pixel survives the gates.
fn population_chromaticity(img: &Image) -> [f32; 3] {
    let s = img.pixels.iter().fold([0.0_f64; 3], |a, p| {
        [a[0] + p[0] as f64, a[1] + p[1] as f64, a[2] + p[2] as f64]
    });
    [(s[0] / s[1]) as f32, 1.0, (s[2] / s[1]) as f32]
}

/// The generic tier converts through `neutral_to_temp_tint`, so an expected
/// neutral pins the expected pair exactly.
fn assert_pair_matches_neutral(got: (f32, f32), neutral: [f32; 3], what: &str) {
    let want = neutral_to_temp_tint(neutral);
    assert!(
        (got.0 - want.0).abs() < 5.0 && (got.1 - want.1).abs() < 0.5,
        "{what}: got {got:?}, expected {want:?} for neutral {neutral:?}"
    );
}

// ---- Generic tier: the gates and the blend ----

#[test]
fn awb_pure_grey_returns_near_d65() {
    let img = flat_image(0.18, 0.18, 0.18);
    let raw = make_raw([0.5, 1.0, 0.7]);
    let (temp, tint) = compute_awb(&img, &raw, &probe_model());
    assert!(
        (temp - 6500.0).abs() < 1500.0,
        "pure-grey should give temperature near 6500K, got {temp}"
    );
    assert!(
        tint.abs() < 30.0,
        "pure-grey should give tint near 0, got {tint}"
    );
}

#[test]
fn awb_warm_cast_gives_lower_kelvin() {
    // A gentle warm (reddish) cast: R > G = B → neutral.R > neutral.B →
    // a LOW-CCT (warm) source that D65 development under-corrected.
    let img = flat_image(0.30, 0.25, 0.20);
    let raw = make_raw([0.5, 1.0, 0.7]);
    let (temp, _tint) = compute_awb(&img, &raw, &probe_model());
    assert!(
        temp < 6500.0,
        "warm-cast scene should give temperature < 6500K, got {temp}"
    );
}

#[test]
fn awb_saturated_subject_does_not_dominate() {
    // 75% neutral at 0.4 plus 25% saturated red: the chroma gate drops the
    // red at every schedule step, so the estimate stays neutral.
    let mut img = Image::new(128, 128, ColorSpace::SceneLinearRec2020);
    let neutral_count = (img.pixels.len() * 3) / 4;
    for px in img.pixels[..neutral_count].iter_mut() {
        *px = [0.4, 0.4, 0.4];
    }
    for px in img.pixels[neutral_count..].iter_mut() {
        *px = [0.8, 0.05, 0.05];
    }
    let raw = make_raw([0.5, 1.0, 0.7]);
    let got = compute_awb(&img, &raw, &probe_model());
    assert_pair_matches_neutral(got, [1.0, 1.0, 1.0], "saturated subject");
}

#[test]
fn awb_too_few_pixels_falls_back_to_as_shot_neutral() {
    // Every pixel is crushed black (below the luma floor) — none survive,
    // so the camera-matrix-aware as-shot estimate is returned (#1725).
    let mut img = Image::new(16, 16, ColorSpace::SceneLinearRec2020);
    for px in &mut img.pixels {
        *px = [0.001, 0.001, 0.001];
    }
    let raw = make_raw([0.52, 1.0, 0.68]);
    let as_shot = dcp::estimate_as_shot_cct_tint(&raw).unwrap();
    // The fallback is still a slider recommendation: this synthetic body's
    // as-shot solve reads +154 tint against a -150..150 slider, so what
    // comes back is that reading pinned to the domain, not the raw pair.
    let want = into_schema_domain(as_shot);
    assert_ne!(want, as_shot, "fixture no longer exercises the pin");
    let got = compute_awb(&img, &raw, &probe_model());
    assert!(
        (got.0 - want.0).abs() < 1.0 && (got.1 - want.1).abs() < 1.0,
        "fallback mismatch: got {got:?}, expected {want:?}"
    );
}

#[test]
fn awb_excludes_channels_at_the_sensor_clip_ceiling() {
    // BaselineExposure −0.5 puts the neutral clip level at 0.707. The blown
    // population sits with G exactly at that ceiling and R running away
    // (the test_0017 sky): luma 0.81, inside the OLD fixed 0.9 window and
    // inside the old chroma gate, and it was the entire old "white patch".
    // With ceilings derived from the develop scale it never votes.
    let mut img = Image::new(128, 128, ColorSpace::SceneLinearRec2020);
    let neutral_count = (img.pixels.len() * 9) / 10;
    for px in img.pixels[..neutral_count].iter_mut() {
        *px = [0.3, 0.3, 0.3];
    }
    for px in img.pixels[neutral_count..].iter_mut() {
        *px = [1.06, 0.707, 0.85];
    }
    let raw = RawImage {
        baseline_exposure: -0.5,
        ..make_raw([0.5, 1.0, 0.7])
    };
    let got = compute_awb(&img, &raw, &probe_model());
    assert_pair_matches_neutral(got, [1.0, 1.0, 1.0], "clipped sky");
}

#[test]
fn awb_blends_gray_world_and_white_patch_as_chromaticities() {
    // 99% gray at 0.15, 1% bright neutral-ish at [0.9, 0.75, 0.75] (luma
    // 0.79: white-patch material, unclipped). On un-normalised sums the
    // bright term would carry 77% of the vote; on chromaticities it
    // carries the documented 40%: 0.6·[1,1,1] + 0.4·[1.2,1,1].
    let mut img = Image::new(400, 400, ColorSpace::SceneLinearRec2020);
    let gray_count = (img.pixels.len() * 99) / 100;
    for px in img.pixels[..gray_count].iter_mut() {
        *px = [0.15, 0.15, 0.15];
    }
    for px in img.pixels[gray_count..].iter_mut() {
        *px = [0.9, 0.75, 0.75];
    }
    let raw = make_raw([0.5, 1.0, 0.7]);
    let got = compute_awb(&img, &raw, &probe_model());
    let gray = population_chromaticity(&img);
    let blend = [0, 1, 2].map(|k| 0.6 * gray[k] + 0.4 * [1.2, 1.0, 1.0][k]);
    assert_pair_matches_neutral(got, blend, "normalised blend");
}

#[test]
fn awb_white_patch_needs_a_real_population() {
    // 100 bright pixels out of 16,384 clear the old 64-pixel bar and the
    // share bar, but not the absolute minimum — gray-world alone decides.
    let mut img = Image::new(128, 128, ColorSpace::SceneLinearRec2020);
    for px in &mut img.pixels {
        *px = [0.15, 0.15, 0.15];
    }
    for px in img.pixels[..100].iter_mut() {
        *px = [0.9, 0.75, 0.75];
    }
    let raw = make_raw([0.5, 1.0, 0.7]);
    let got = compute_awb(&img, &raw, &probe_model());
    assert_pair_matches_neutral(
        got,
        population_chromaticity(&img),
        "white patch below minimum",
    );
}

#[test]
fn awb_chroma_gate_recentres_on_a_strong_cast() {
    // Two neutral surfaces under a strong warm light, both beyond the old
    // fixed 0.25 gate relative to the D65 render (0.31 and 0.29), so the
    // old estimator rejected the entire frame and fell back. The schedule
    // admits them at 0.5, re-centres, and lands on the mixture.
    let mut img = Image::new(128, 128, ColorSpace::SceneLinearRec2020);
    let split = (img.pixels.len() * 6) / 10;
    for px in img.pixels[..split].iter_mut() {
        *px = [0.45, 0.30, 0.18];
    }
    for px in img.pixels[split..].iter_mut() {
        *px = [0.28, 0.20, 0.12];
    }
    let raw = make_raw([0.5, 1.0, 0.7]);
    let got = compute_awb(&img, &raw, &probe_model());
    assert_pair_matches_neutral(got, population_chromaticity(&img), "strong cast");
}

// ---- The as-shot bound ----

#[test]
fn bound_leaves_an_estimate_inside_the_band_alone() {
    let prior = (5000.0, 5.0);
    let inside = (1.0e6 / (200.0 + 40.0), 20.0); // +40 mired, +15 tint
    assert_eq!(bounded_by_prior(inside, prior), inside);
}

#[test]
fn bound_clamps_a_runaway_estimate_to_the_band_edge() {
    let prior = (5000.0, 5.0); // 200 mired
    let runaway = (12000.0, 60.0); // 83 mired: −117 mired and +55 tint away
    let (t, tint) = bounded_by_prior(runaway, prior);
    assert!(
        ((1.0e6 / t) - (200.0 - MAX_MIRED_MOVE)).abs() < 0.01,
        "got {t} K"
    );
    assert!(
        (tint - (5.0 + MAX_TINT_MOVE)).abs() < 1e-3,
        "got tint {tint}"
    );
    let runaway_warm = (2000.0, -80.0); // 500 mired
    let (t, tint) = bounded_by_prior(runaway_warm, prior);
    assert!(
        ((1.0e6 / t) - (200.0 + MAX_MIRED_MOVE)).abs() < 0.01,
        "got {t} K"
    );
    assert!(
        (tint - (5.0 - MAX_TINT_MOVE)).abs() < 1e-3,
        "got tint {tint}"
    );
}

#[test]
fn bound_ignores_a_railed_as_shot_reading() {
    // test_0004's shape: the frame can't invert the calibration and the
    // as-shot solve rails to +180 tint. Pinning to it would be worse than
    // any estimate.
    let railed = (9659.0, 179.8);
    let estimate = (6466.0, -1.8);
    assert_eq!(bounded_by_prior(estimate, railed), estimate);
    let out_of_domain = (15000.0, 0.0);
    assert_eq!(bounded_by_prior(estimate, out_of_domain), estimate);
}

#[test]
fn every_recommendation_lands_in_the_slider_domain() {
    // The recommendation is a slider value on every path, including the two
    // that are not themselves bounded by the schema: the fallback (the
    // camera's own reading — test_0004's railed +180 tint) and the band,
    // which reaches MAX_TINT_MOVE past the edge from an in-domain prior.
    let (t_lo, t_hi) = schema_range("temperature");
    let (tint_lo, tint_hi) = schema_range("tint");
    let railed_as_shot = (9659.0, 179.8);
    assert!(!in_schema_domain(railed_as_shot));
    assert_eq!(into_schema_domain(railed_as_shot), (9659.0, tint_hi));

    let at_the_edge = (5000.0, tint_hi);
    let over = bounded_by_prior((5000.0, tint_hi + 200.0), at_the_edge);
    assert!(over.1 > tint_hi, "the band alone overshoots: {}", over.1);
    assert_eq!(into_schema_domain(over).1, tint_hi);

    assert_eq!(into_schema_domain((t_lo - 1000.0, 0.0)).0, t_lo);
    assert_eq!(into_schema_domain((t_hi + 1000.0, 0.0)).0, t_hi);
    assert_eq!(into_schema_domain((5000.0, tint_lo - 50.0)).1, tint_lo);
}

// ---- Calibrated tier: the whole develop chain, end to end ----

/// Canon EOS 5D Mark III Adobe ColorMatrix (XYZ→camera, D65 column). A
/// real calibration so `dcp::profile_for` takes the embedded-CM tier and
/// `stages::wb_camera` owns the white balance, as it does for every
/// calibrated body.
const CALIBRATION_CM: Matrix3 = Matrix3([
    [0.6722, -0.0635, -0.0963],
    [-0.4287, 1.2460, 0.2028],
    [-0.0908, 0.2162, 0.5668],
]);

const AS_SHOT_NEUTRAL: [f32; 3] = [0.5, 1.0, 0.7];

/// A 128×128 RGGB Bayer `RawImage` painted from `scene(x, y)`, which
/// returns per-channel camera-linear values as fractions of the white
/// level (BEFORE any pre-gain). Values past 1.0 clip at the sensor.
fn calibrated_raw(baseline_exposure: f32, scene: impl Fn(u32, u32) -> [f32; 3]) -> RawImage {
    const W: u32 = 128;
    const H: u32 = 128;
    // 16-bit so sample quantisation stays far below the solve's sensitivity
    // (1% in R/B ≈ 100 K at daylight; 12-bit rounding alone cost ~60 K).
    const WHITE: u32 = 65535;
    let raw_data = (0..H)
        .flat_map(|y| (0..W).map(move |x| (x, y)))
        .map(|(x, y)| {
            let color = CfaPattern::Rggb.color_at(x, y) as usize;
            (scene(x, y)[color] * WHITE as f32)
                .round()
                .clamp(0.0, WHITE as f32) as u16
        })
        .collect();
    RawImage {
        width: W,
        height: H,
        white_level: WHITE,
        raw_data,
        as_shot_neutral: AS_SHOT_NEUTRAL,
        color_matrices: [(Illuminant::D65, CALIBRATION_CM)].into_iter().collect(),
        baseline_exposure,
        ..make_raw(AS_SHOT_NEUTRAL)
    }
}

/// A flat field of neutral surfaces under a light the camera reads as
/// `neutral`, at mid-gray level — nothing near the clip point, and no edge:
/// the Preview-quality half-res demosaic reads R and B from quads one row
/// apart, so a hard horizontal edge in the synthetic scene turns into a
/// two-row coloured fringe that measures the demosaic, not the estimate.
fn neutral_scene(neutral: [f32; 3]) -> impl Fn(u32, u32) -> [f32; 3] {
    move |_x, _y| neutral.map(|n| n * 0.3)
}

/// The caller's model, as AUTO receives it. Colour noise reduction (default
/// 25) and sharpening are spatial filters that smear a hard synthetic edge
/// into a coloured fringe several rows wide; a real scene's edges are what
/// they are, but here they would only measure the filters, not the estimate.
fn scene_model() -> AdjustmentModel {
    AdjustmentModel {
        nr_color: 0.0,
        sharpen_amount: 0.0,
        ..AdjustmentModel::default()
    }
}

/// CI diagnostic: everything between the synthetic sensor and the pair.
fn describe(raw: &RawImage, model: &AdjustmentModel) {
    use crate::pipeline::{develop_scene_linear_from_raw_with_quality, RenderQuality};
    use crate::types::adjustment::AutoExposureMode;
    let probe_model = AdjustmentModel {
        auto_exposure: AutoExposureMode::Off,
        ..model.clone()
    };
    let probe =
        develop_scene_linear_from_raw_with_quality(raw, &probe_model, RenderQuality::Preview)
            .unwrap();
    let (profile, source) = dcp::profile_for_with_source(raw).unwrap();
    let frame = SliderFrame::resolve(raw, &profile);
    let space = ProbeSpace::resolve(raw, &probe_model);
    let target =
        wb_camera::resolve_target_versioned(&probe_model, &frame, &profile, raw.as_shot_neutral);
    let as_shot_seed = wb_camera::resolve_target(&probe_model, &frame);
    println!(
        "target={target:?} seed={as_shot_seed:?} scene_cct={} diff={} seen=({},{}) version={:?} model_wb=({},{}) gain_at_target={:?}",
        frame.scene_cct,
        target.0 - frame.scene_cct,
        probe_model.temperature_seen,
        probe_model.tint_seen,
        probe_model.wb_scale_version,
        probe_model.temperature,
        probe_model.tint,
        wb_camera::camera_wb_gain(&frame, raw.as_shot_neutral, target.0, target.1)
    );
    let n = probe.pixels.len() as f64;
    let mean = probe.pixels.iter().fold([0.0f64; 3], |a, p| {
        [a[0] + p[0] as f64, a[1] + p[1] as f64, a[2] + p[2] as f64]
    });
    let mean = mean.map(|v| (v / n) as f32);
    let neutral = estimate_neutral(&probe, &space);
    println!(
        "source={source:?} scene_white={:?} cm={:?} scene_cct={} ceilings={:?} prior={:?} \
         probe mean={mean:?} in space={:?} px[0]={:?} px[last]={:?} neutral={neutral:?} \
         pair={:?} as-shot={:?}",
        profile.scene_white_xyz,
        profile.color_matrix,
        frame.scene_cct,
        space.ceilings,
        space.prior,
        space.to_space.mul_vec(mean),
        probe.pixels[0],
        probe.pixels[probe.pixels.len() - 1],
        neutral.and_then(|nn| space.temp_tint(nn)),
        dcp::estimate_as_shot_cct_tint(raw)
    );
}

fn assert_recommends(a: (f32, f32), want: (f32, f32), what: &str) {
    assert!(
        (a.0 - want.0).abs() < 10.0 && (a.1 - want.1).abs() < 0.5,
        "{what}: recommended {a:?}, expected {want:?}"
    );
}

#[test]
fn calibrated_neutral_scene_recommends_the_camera_as_shot_pair() {
    let raw = calibrated_raw(0.0, neutral_scene(AS_SHOT_NEUTRAL));
    describe(&raw, &scene_model());
    let a = compute_auto_adjustments(&raw, &scene_model()).unwrap();
    let want = dcp::estimate_as_shot_cct_tint(&raw).unwrap();
    assert_recommends((a.temperature, a.tint), want, "neutral scene");
}

#[test]
fn calibrated_scene_with_a_clipped_sky_still_recommends_as_shot() {
    // The top quarter is a blown sky: G and B at the sensor ceiling, R at
    // 80% — the test_0017 signature. BaselineExposure −0.6 keeps its
    // developed luma under the old 0.9 window, and its post-pre-gain
    // chromaticity [1.6, 1, 1.43] passed the old chroma gate too.
    let neutral = neutral_scene(AS_SHOT_NEUTRAL);
    let raw = calibrated_raw(-0.6, move |x, y| {
        if y < 32 {
            [0.8, 1.6, 1.12]
        } else {
            neutral(x, y)
        }
    });
    let a = compute_auto_adjustments(&raw, &scene_model()).unwrap();
    let want = dcp::estimate_as_shot_cct_tint(&raw).unwrap();
    assert_recommends((a.temperature, a.tint), want, "clipped sky");
}

#[test]
fn calibrated_scene_under_another_light_solves_that_light_in_the_slider_frame() {
    // Neutral surfaces under a tungsten-ish light the camera would have
    // read as [0.85, 1, 0.45], while the file's AsShotNeutral says
    // daylight. Relative to the as-shot render the cast is 0.35 on the
    // old gate's scale — rejected outright before #2247. The right answer
    // for the solve is what the camera's own estimator says for THAT
    // neutral; the recommendation is that answer clamped to the as-shot
    // band, since 5600 K → 2500 K is 217 mired, past `MAX_MIRED_MOVE`.
    use crate::pipeline::{develop_scene_linear_from_raw_with_quality, RenderQuality};
    use crate::types::adjustment::AutoExposureMode;
    let scene_neutral = [0.85, 1.0, 0.45];
    let raw = calibrated_raw(0.0, neutral_scene(scene_neutral));
    let metered = RawImage {
        as_shot_neutral: scene_neutral,
        ..calibrated_raw(0.0, neutral_scene(scene_neutral))
    };
    let want = dcp::estimate_as_shot_cct_tint(&metered).unwrap();

    // The solve itself, before the bound.
    let probe_model = AdjustmentModel {
        auto_exposure: AutoExposureMode::Off,
        ..scene_model()
    };
    let probe =
        develop_scene_linear_from_raw_with_quality(&raw, &probe_model, RenderQuality::Preview)
            .unwrap();
    let space = ProbeSpace::resolve(&raw, &probe_model);
    let solved = space
        .temp_tint(estimate_neutral(&probe, &space).unwrap())
        .unwrap();
    assert_recommends(solved, want, "tungsten scene (solve)");

    // The recommendation: the same answer, clamped to the as-shot band.
    let as_shot = dcp::estimate_as_shot_cct_tint(&raw).unwrap();
    let a = compute_auto_adjustments(&raw, &scene_model()).unwrap();
    assert_recommends(
        (a.temperature, a.tint),
        bounded_by_prior(want, as_shot),
        "tungsten scene (bounded)",
    );
    assert!(
        (1.0e6 / a.temperature - 1.0e6 / as_shot.0 - MAX_MIRED_MOVE).abs() < 0.5,
        "the recommendation must sit on the warm edge of the band: {a:?} vs as-shot {as_shot:?}"
    );
}
