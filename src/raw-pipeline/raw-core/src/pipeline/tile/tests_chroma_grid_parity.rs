#![cfg(test)]
//! Half-resolution chroma NR anchors its 2×2 grid to frame coordinates, so a
//! deep-zoom tile at an odd origin must land on the same grid phase as the
//! export's full develop. `tests_full_parity` only covers an even origin,
//! where a tile-local grid would agree by accident.

use super::tests_live_parity::camera_chart_raw;
use super::*;
use crate::image::Image;
use crate::pipeline::develop_scene_linear_from_raw_with_quality;
use crate::xmp::AutoExposureMode;

const ODD_RECT: TileRect = TileRect {
    src_x: 97,
    src_y: 83,
    src_w: 223,
    src_h: 191,
    out_w: 223,
    out_h: 191,
};

fn model(nr_color: f32) -> AdjustmentModel {
    AdjustmentModel {
        sharpen_amount: 0.0,
        nr_luminance: 0.0,
        nr_color,
        auto_exposure: AutoExposureMode::Off,
        ..AdjustmentModel::default()
    }
}

fn rect_lanes(full: &Image) -> Vec<f32> {
    let w = full.width as usize;
    (0..ODD_RECT.src_h as usize)
        .flat_map(|y| {
            (0..ODD_RECT.src_w as usize).flat_map(move |x| {
                full.pixels[(ODD_RECT.src_y as usize + y) * w + ODD_RECT.src_x as usize + x]
            })
        })
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
        .fold(0.0, f32::max)
}

#[test]
fn odd_origin_tile_matches_the_full_develop_with_half_res_chroma_nr() {
    let raw = camera_chart_raw();
    let full = |nr_color| {
        rect_lanes(
            &develop_scene_linear_from_raw_with_quality(
                &raw,
                &model(nr_color),
                RenderQuality::Full,
            )
            .expect("full develop"),
        )
    };
    let untouched = full(0.0);
    for nr_color in [25.0, 100.0] {
        let export = full(nr_color);
        let (w, h, rgba) = render_scene_linear_tile_from_raw_with_quality_f32(
            &raw,
            &model(nr_color),
            ODD_RECT,
            RenderQuality::Full,
        )
        .expect("tile render");
        assert_eq!((w, h), (ODD_RECT.out_w, ODD_RECT.out_h));
        let tile: Vec<f32> = rgba
            .chunks_exact(4)
            .flat_map(|px| [px[0], px[1], px[2]])
            .collect();
        let moved = max_abs(&export, &untouched);
        let diff = max_abs(&export, &tile);
        assert!(
            moved > 1e-3,
            "nr_color {nr_color}: chroma NR moved the rect by only {moved:.3e}"
        );
        assert!(
            diff <= 1e-4,
            "nr_color {nr_color}: odd-origin tile diverges from the full develop by {diff:.4e}"
        );
    }
}
