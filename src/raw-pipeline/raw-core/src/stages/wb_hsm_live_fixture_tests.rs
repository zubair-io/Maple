//! Fixture-gated live-vs-refine white-balance seam on dual-HueSatMap
//! ForwardMatrix bodies (#5099), such as test_0007 (Canon 5D Mark III DNG):
//! since #4633 a fresh develop re-lerps the HueSatMap at the white-balance
//! target. The CPU per-tick chain runs over a buffer developed at the
//! as-shot white and must land on that develop too, HueSatMap included.

use crate::color::dcp;
use crate::image::{ColorSpace, Image};
use crate::pipeline::{
    apply_scene_linear_chain_f32, render_scene_linear_sized_from_raw_with_quality_f32_cancellable,
    ChainOptions, RenderQuality,
};
use crate::stages::wb_camera::{SliderFrameExport, WbHsmRetarget};
use crate::view::acr_fit::model::{ciede2000, srgb_linear_to_lab};
use crate::xmp::{AdjustmentModel, AutoExposureMode};
use crate::CancelToken;

const LONG_EDGE: u32 = 512;

/// Live-vs-refine agreement in display u8: ΔE00 mean / p95 / max, the
/// count of pixels past 1 ΔE00, and the largest channel step. Also the
/// shape of each case's ceiling.
#[derive(Clone, Copy, Debug)]
pub(crate) struct SeamStats {
    pub mean: f32,
    pub p95: f32,
    pub max: f32,
    pub over_one: usize,
    pub max_channel: u8,
}

impl SeamStats {
    pub(crate) fn within(&self, ceiling: &SeamStats) -> bool {
        self.mean <= ceiling.mean
            && self.p95 <= ceiling.p95
            && self.max <= ceiling.max
            && self.over_one <= ceiling.over_one
            && self.max_channel <= ceiling.max_channel
    }
}

fn display_u8(scene_rgba: &[f32], w: u32, h: u32) -> Vec<u8> {
    let mut img = Image::new(w, h, ColorSpace::SceneLinearRec2020);
    for (p, c) in img.pixels.iter_mut().zip(scene_rgba.chunks_exact(4)) {
        *p = [c[0], c[1], c[2]];
    }
    crate::view::agx::apply(&mut img, 0.0, 0.0);
    crate::view::encode::rec2020_to_srgb(&mut img);
    crate::view::encode::srgb_gamma_encode(&mut img);
    img.pixels
        .iter()
        .flat_map(|p| p.map(|v| (v.clamp(0.0, 1.0) * 255.0).round() as u8))
        .collect()
}

fn srgb_decode(c: u8) -> f32 {
    let v = c as f32 / 255.0;
    if v <= 0.04045 {
        v / 12.92
    } else {
        ((v + 0.055) / 1.055).powf(2.4)
    }
}

pub(crate) fn seam_stats(a: &[u8], b: &[u8]) -> SeamStats {
    let lab =
        |p: &[u8]| srgb_linear_to_lab([srgb_decode(p[0]), srgb_decode(p[1]), srgb_decode(p[2])]);
    let mut des: Vec<f32> = a
        .chunks_exact(3)
        .zip(b.chunks_exact(3))
        .map(|(pa, pb)| ciede2000(lab(pa), lab(pb)))
        .collect();
    des.sort_by(f32::total_cmp);
    let max_channel = a
        .iter()
        .zip(b)
        .map(|(x, y)| x.abs_diff(*y))
        .max()
        .unwrap_or(0);
    SeamStats {
        mean: des.iter().sum::<f32>() / des.len() as f32,
        p95: des[((des.len() as f32 * 0.95) as usize).min(des.len() - 1)],
        max: *des.last().unwrap_or(&0.0),
        over_one: des.iter().filter(|d| **d > 1.0).count(),
        max_channel,
    }
}

/// Realistic and extreme drags off a fixture's as-shot `anchor`, each with
/// its ceiling, for every fixture whose HueSatMap moves. Landing on
/// test_0007 (512 px long edge) with the HueSatMap carried: mean/p95
/// 0.000 at every drag, at most 2 pixels past 1 ΔE00 (max 3.0, 11 u8 steps,
/// at the extremes, where the table's saturation clamp has no exact
/// inverse). The plain 3×3 it replaces: mean 0.11 (warm 500 K) to 1.78
/// (2000 K), max channel up to 27.
pub(crate) fn seam_cases(anchor: (f32, f32)) -> [(&'static str, (f32, f32), SeamStats); 6] {
    let drag = SeamStats {
        mean: 0.02,
        p95: 0.05,
        max: 3.5,
        over_one: 8,
        max_channel: 13,
    };
    [
        (
            "as-shot",
            anchor,
            SeamStats {
                mean: 0.01,
                p95: 0.01,
                max: 0.6,
                over_one: 0,
                max_channel: 1,
            },
        ),
        ("warm-500", (anchor.0 + 500.0, anchor.1 + 8.0), drag),
        ("cool-800", (anchor.0 - 800.0, anchor.1 - 10.0), drag),
        ("temperature_min", (2000.0, 0.0), drag),
        ("tungsten", (2850.0, 0.0), drag),
        ("temperature_max", (50000.0, 0.0), drag),
    ]
}

/// The case failures of one fixture, or `None` when its profile's HueSatMap
/// does not move with white balance (the plain 3×3 is then the whole story).
fn seam_failures(raw: &crate::image::RawImage, name: &str) -> Option<Vec<String>> {
    let (profile, source) = dcp::profile_for_with_source(raw).ok()?;
    // The decode exports no frame for these tiers (`wb_exports`), so no live
    // HueSatMap either.
    let lossy = matches!(raw.cfa, crate::image::CfaPattern::LinearRgb) && raw.white_level <= 255;
    if lossy || matches!(source, dcp::ProfileSource::RawlerFallback) {
        return None;
    }
    let hsm = WbHsmRetarget::resolve(&profile)?;
    let frame = SliderFrameExport::resolve(raw, &profile);
    let anchor = (frame.scene_cct, frame.as_shot_tint);
    let bake_model = AdjustmentModel {
        auto_exposure: AutoExposureMode::Off,
        sharpen_amount: 0.0,
        nr_color: 0.0,
        nr_luminance: 0.0,
        ..AdjustmentModel::default()
    };
    let develop = |model: &AdjustmentModel| {
        render_scene_linear_sized_from_raw_with_quality_f32_cancellable(
            raw,
            model,
            RenderQuality::Preview,
            LONG_EDGE,
            CancelToken::never(),
        )
        .expect("develop")
    };
    let (w, h, bake) = develop(&bake_model);
    let failures = seam_cases(anchor)
        .into_iter()
        .filter_map(|(case, target, ceiling)| {
            let model = AdjustmentModel {
                temperature: target.0,
                tint: target.1,
                temperature_seen: true,
                tint_seen: true,
                ..bake_model.clone()
            };
            let (_, _, refine) = develop(&model);
            let live = apply_scene_linear_chain_f32(
                &bake,
                w,
                h,
                &model,
                &ChainOptions {
                    decoded_temp: anchor.0,
                    decoded_tint: anchor.1,
                    wb_frame: Some(&frame),
                    wb_hsm: Some(hsm.view(1.0)),
                    skip_agx: true,
                    ..ChainOptions::default()
                },
            )
            .expect("live chain");
            let s = seam_stats(&display_u8(&live, w, h), &display_u8(&refine, w, h));
            eprintln!("{name} CPU live-vs-refine [{case}] @ {target:?}: {s:?}");
            (!s.within(&ceiling)).then(|| format!("{name} [{case}] {s:?} over {ceiling:?}"))
        })
        .collect();
    Some(failures)
}

/// Every fixture whose profile moves its HueSatMap with white balance;
/// test_0007 (Canon 5D Mark III, dual HSM + FM) must be among them.
#[test]
#[cfg_attr(
    not(feature = "fixtures"),
    ignore = "needs test-fixtures/raws (fixtures feature)"
)]
fn cpu_live_wb_drag_matches_refine_on_every_moving_hsm_fixture() {
    let root = crate::test_support::fixtures::require(crate::test_support::fixtures::raws_root());
    let mut names: Vec<String> = std::fs::read_dir(&root)
        .expect("raws dir")
        .filter_map(|e| e.ok()?.file_name().into_string().ok())
        .filter(|n| n.starts_with("test_") && !n.contains(".xmp"))
        .collect();
    names.sort();
    let engaged: Vec<(String, Vec<String>)> = names
        .iter()
        .filter_map(|name| {
            let raw = crate::decode::decode(&root.join(name)).ok()?;
            Some((name.clone(), seam_failures(&raw, name)?))
        })
        .collect();
    eprintln!(
        "fixtures with a moving HueSatMap: {:?}",
        engaged.iter().map(|(n, _)| n).collect::<Vec<_>>()
    );
    assert!(
        engaged.iter().any(|(n, _)| n.starts_with("test_0007")),
        "test_0007 must carry a moving HueSatMap"
    );
    let failures: Vec<&String> = engaged.iter().flat_map(|(_, f)| f).collect();
    assert!(
        failures.is_empty(),
        "live-vs-refine seam over budget: {failures:#?}"
    );
}
