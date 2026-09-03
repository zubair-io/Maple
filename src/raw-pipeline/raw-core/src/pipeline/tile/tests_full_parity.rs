#![cfg(test)]
//! **#1157 gate: the tile chain vs the FULL develop, for every stage the
//! tile path renders — including the ones #1157 un-gated.**
//!
//! `tests_live_parity.rs` compares the tile against the per-tick LIVE chain,
//! which is the right oracle for the slider-tick stages but cannot exercise
//! vignette, local adjustments or capture sharpening: the live chain
//! anchors those to the buffer it is handed, and capture sharpening runs
//! before the decode it starts from. The whole-image develop is the oracle
//! for those — it is what the tile must reproduce pixel for pixel inside
//! the requested rect, given the window (`TileWindow`) and the computed
//! overlap (`overlap.rs`) the entry now threads through.
//!
//! Fixture-free, on the same synthetic camera-encoded chart as the live
//! gate, so it runs on every CI machine. The fixture-gated sibling on a real
//! RAW is `tests_render_anchors::tile_matches_full_chain_with_all_spatial_sliders`.

use super::tests_live_parity::{camera_chart_raw, RECT};
use super::*;
use crate::image::Image;
use crate::pipeline::develop_scene_linear_from_raw_with_quality;
use crate::types::{LocalAdjustment, Mask, PartialAdjustments, Point2};
use crate::xmp::AutoExposureMode;

/// Every case must move the developed buffer by at least this much, so a
/// near-no-op model cannot pass the ceilings for the wrong reason.
const MIN_CASE_EFFECT: f32 = 1e-2;

struct Case {
    name: &'static str,
    model: AdjustmentModel,
    /// Ceiling on the largest absolute per-lane difference. `0.0` means the
    /// case is a point op given the window and must be BIT-EXACT.
    max_abs: f32,
}

fn radial_layer() -> LocalAdjustment {
    LocalAdjustment {
        mask: Mask::Radial {
            center: Point2::new(0.45, 0.5),
            radii: Point2::new(0.3, 0.22),
            angle: 0.35,
            feather: 0.5,
            invert: false,
        },
        adjustments: PartialAdjustments {
            exposure: Some(0.8),
            saturation: Some(30.0),
            ..PartialAdjustments::default()
        },
    }
}

fn cases() -> Vec<Case> {
    // Every position-dependent accumulation off (sharpen / NR row sums, see
    // `tests_render_anchors.rs`) so the point-op cases can demand bit
    // equality; the combined case turns them back on under a ceiling.
    let base = AdjustmentModel {
        sharpen_amount: 0.0,
        nr_color: 0.0,
        nr_luminance: 0.0,
        auto_exposure: AutoExposureMode::Off,
        ..AdjustmentModel::default()
    };
    vec![
        Case {
            name: "vignette (windowed to the frame)",
            model: AdjustmentModel {
                vignette_amount: -60.0,
                vignette_feather: 40.0,
                ..base.clone()
            },
            max_abs: 0.0,
        },
        Case {
            name: "local adjustments (radial + linear, frame-normalised masks)",
            model: AdjustmentModel {
                local_adjustments: vec![
                    radial_layer(),
                    LocalAdjustment::linear(
                        Point2::new(0.0, 0.0),
                        Point2::new(1.0, 1.0),
                        PartialAdjustments {
                            shadows: Some(40.0),
                            ..PartialAdjustments::default()
                        },
                    ),
                ],
                ..base.clone()
            },
            max_abs: 0.0,
        },
        Case {
            name: "capture sharpening (computed overlap)",
            model: AdjustmentModel {
                capture_sharpening_amount: 60.0,
                capture_sharpening_sigma: 1.5,
                ..base.clone()
            },
            max_abs: 1.0e-4,
        },
        Case {
            name: "every spatial slider engaged",
            model: AdjustmentModel {
                highlights: -30.0,
                shadows: 30.0,
                clarity: 20.0,
                texture: 20.0,
                capture_sharpening_amount: 60.0,
                capture_sharpening_sigma: 1.5,
                vignette_amount: -40.0,
                vignette_feather: 50.0,
                local_adjustments: vec![radial_layer()],
                sharpen_amount: 40.0,
                sharpen_radius: 1.0,
                nr_luminance: 20.0,
                nr_color: 25.0,
                ..base.clone()
            },
            max_abs: 1.0e-4,
        },
    ]
}

/// The full develop's pixels over [`RECT`], as RGB lanes.
fn full_rect_lanes(full: &Image) -> Vec<f32> {
    let w = full.width as usize;
    let mut out = Vec::with_capacity((RECT.src_w * RECT.src_h * 3) as usize);
    for y in 0..RECT.src_h as usize {
        for x in 0..RECT.src_w as usize {
            let p = full.pixels[(RECT.src_y as usize + y) * w + RECT.src_x as usize + x];
            out.extend_from_slice(&p);
        }
    }
    out
}

/// The tile's pixels over [`RECT`], as RGB lanes (alpha dropped).
fn tile_lanes(raw: &crate::image::RawImage, model: &AdjustmentModel) -> Vec<f32> {
    let (w, h, rgba) =
        render_scene_linear_tile_from_raw_with_quality_f32(raw, model, RECT, RenderQuality::Full)
            .expect("tile render");
    assert_eq!((w, h), (RECT.out_w, RECT.out_h), "tile output dims");
    rgba.chunks_exact(4)
        .flat_map(|px| [px[0], px[1], px[2]])
        .collect()
}

fn max_abs(a: &[f32], b: &[f32]) -> f32 {
    assert_eq!(a.len(), b.len());
    a.iter()
        .zip(b)
        .map(|(x, y)| {
            assert!(x.is_finite() && y.is_finite(), "non-finite lane");
            (x - y).abs()
        })
        .fold(0.0f32, f32::max)
}

#[test]
fn tile_matches_full_develop_for_windowed_and_computed_overlap_stages() {
    let raw = camera_chart_raw();
    let neutral = full_rect_lanes(
        &develop_scene_linear_from_raw_with_quality(
            &raw,
            &cases()[0].model.clone_with_neutral_stages(),
            RenderQuality::Full,
        )
        .expect("neutral develop"),
    );
    for case in cases() {
        let full = full_rect_lanes(
            &develop_scene_linear_from_raw_with_quality(&raw, &case.model, RenderQuality::Full)
                .expect("full develop"),
        );
        let tile = tile_lanes(&raw, &case.model);
        let diff = max_abs(&full, &tile);
        let moved = max_abs(&full, &neutral);
        eprintln!(
            "[{}] tile-vs-full: max_abs {:.3e} (case moved the image by {:.3e})",
            case.name, diff, moved
        );
        assert!(
            moved > MIN_CASE_EFFECT,
            "[{}] case moved the image by only {:.3e} — too close to a no-op for the ceiling to mean anything",
            case.name,
            moved
        );
        assert!(
            diff <= case.max_abs,
            "[{}] tile diverges from the full develop: max abs diff {:.4e} > {:.4e}",
            case.name,
            diff,
            case.max_abs
        );
    }
}

/// `AdjustmentModel` with every stage this file exercises turned off — the
/// reference the non-vacuity check measures against.
trait NeutralStages {
    fn clone_with_neutral_stages(&self) -> AdjustmentModel;
}

impl NeutralStages for AdjustmentModel {
    fn clone_with_neutral_stages(&self) -> AdjustmentModel {
        AdjustmentModel {
            sharpen_amount: 0.0,
            nr_color: 0.0,
            nr_luminance: 0.0,
            auto_exposure: AutoExposureMode::Off,
            ..AdjustmentModel::default()
        }
    }
}
