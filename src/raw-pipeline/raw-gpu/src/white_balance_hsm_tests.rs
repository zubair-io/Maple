//! Parity gate for `white_balance_hsm.wgsl` (#5099): the WGSL kernel against
//! raw-core's `HsmRetargetView::apply_pixel`, the CPU live chain's own math.

use super::*;
use crate::chain::ChainRunner;
use crate::image::GpuImage;
use raw_core::color::matrices::m_pro_to_rec2020;
use raw_core::math::Matrix3;
use raw_core::stages::wb_camera::{HsmLiveDelta, HsmRetargetView};

/// Endpoint tables over `dims` with hue deltas that cross ±180° between
/// cells near the seam, saturation and value scales varying across the
/// lattice, so every interpolation axis and the hue unwrap carry weight.
fn wire(dims: [u32; 3], srgb: bool) -> Vec<f32> {
    let table = |phase: f32, hue_amp: f32| -> Vec<f32> {
        let [hd, sd, vd] = dims;
        (0..hd)
            .flat_map(|h| (0..sd).flat_map(move |s| (0..vd).map(move |v| (h, s, v))))
            .flat_map(|(h, s, v)| {
                let angle = h as f32 / hd as f32 * std::f32::consts::TAU + phase;
                let sat = s as f32 / (sd - 1).max(1) as f32;
                let val = v as f32 / (vd - 1).max(1) as f32;
                let seam = if h == 0 { 175.0 } else { 0.0 };
                [
                    hue_amp * angle.sin() * sat + seam,
                    1.0 + 0.15 * angle.cos() * sat,
                    1.0 - 0.05 * angle.sin() * sat + 0.03 * val,
                ]
            })
            .collect()
    };
    let header = [
        dims[0] as f32,
        dims[1] as f32,
        dims[2] as f32,
        if srgb { 1.0 } else { 0.0 },
        2856.0,
        6504.0,
    ];
    header
        .into_iter()
        .chain(table(0.0, 9.0))
        .chain(table(1.1, -7.0))
        .collect()
}

/// A spread of Rec.2020 pixels: saturated in every hue sextant, near
/// neutral, HDR above 1, a negative channel, and black.
fn pixels() -> Vec<f32> {
    let mut out = Vec::new();
    for i in 0..48 {
        let angle = i as f32 / 48.0 * std::f32::consts::TAU;
        let level = 0.05 + 0.9 * ((i * 7 % 11) as f32 / 10.0);
        out.extend_from_slice(&[
            level * (0.5 + 0.45 * angle.cos()),
            level * (0.5 + 0.45 * (angle - 2.1).cos()),
            level * (0.5 + 0.45 * (angle + 2.1).cos()),
            1.0,
        ]);
    }
    out.extend_from_slice(&[0.18, 0.18, 0.181, 1.0]);
    out.extend_from_slice(&[3.0, 1.5, 0.4, 0.5]);
    out.extend_from_slice(&[-0.03, 0.2, 0.5, 1.0]);
    out.extend_from_slice(&[0.0, 0.0, 0.0, 1.0]);
    out
}

/// One tick's constants with an exposure gain folded into the ProPhoto
/// round trip, as `HsmRetargetView::live_delta` builds them.
fn delta(w_target: f32, w_anchor: f32, gain: f32) -> HsmLiveDelta {
    let from_pro = m_pro_to_rec2020();
    let to_pro = from_pro.inverse().unwrap();
    let wb = Matrix3([[1.18, 0.04, -0.02], [0.01, 0.99, 0.0], [-0.03, 0.02, 0.82]]);
    let scaled = |m: Matrix3, k: f32| Matrix3(m.0.map(|row| row.map(|v| v * k)));
    HsmLiveDelta {
        to_pro: scaled(to_pro, 1.0 / gain),
        delta_pro: to_pro.mul_mat(&wb).mul_mat(&from_pro),
        from_pro: scaled(from_pro, gain),
        w_target,
        w_anchor,
        inverse_iterations: raw_core::stages::wb_camera::HSM_INVERSE_ITERATIONS,
    }
}

fn inputs<'a>(view: &HsmRetargetView<'a>, d: &HsmLiveDelta) -> WbHsmInputs<'a> {
    WbHsmInputs {
        dims: view.dims,
        srgb: view.encoding == raw_core::color::hsm::HsmEncoding::Srgb,
        tables: WbHsmTables::Borrowed(view.tables),
        to_pro: d.to_pro.0,
        delta_pro: d.delta_pro.0,
        from_pro: d.from_pro.0,
        w_target: d.w_target,
        w_anchor: d.w_anchor,
        inverse_iterations: d.inverse_iterations,
        lift_bisection_steps: raw_core::color::hsm::LIFT_BISECTION_STEPS,
    }
}

/// Relative to max(|value|, 1). Metal and the CPU differ in the last ulp of
/// the HSV round trips and `rem_euclid`, which the inverse steps carry;
/// measured worst 2.6e-5 on Metal (the linear 6×4×3 table).
const PARITY_TOLERANCE: f32 = 1e-4;

#[test]
fn wgsl_hsm_white_balance_matches_raw_core() {
    let ctx = GpuContext::new_blocking().expect("gpu context");
    let input = pixels();
    let count = (input.len() / 4) as u32;
    for (dims, srgb) in [
        ([90, 30, 1], false),
        ([36, 8, 16], true),
        ([6, 4, 3], false),
    ] {
        let flat = wire(dims, srgb);
        let view = HsmRetargetView::from_wire(&flat, 4100.0, 1.0).expect("valid wire");
        for (w_target, w_anchor, gain) in [(0.0, 0.62, 1.0), (1.0, 0.3, 2.3), (0.45, 0.45, 0.6)] {
            let d = delta(w_target, w_anchor, gain);
            let hsm = inputs(&view, &d);
            let img = GpuImage::upload(&ctx, &input, count, 1);
            let runner = ChainRunner::new(&ctx, &img);
            let gpu = runner.run_blocking(&[&WhiteBalancePass {
                matrix: [[0.0; 3]; 3],
                hsm: Some(&hsm),
            }]);
            let max_diff = input
                .chunks_exact(4)
                .zip(gpu.chunks_exact(4))
                .map(|(i, g)| {
                    let want = view.apply_pixel(&d, [i[0], i[1], i[2]]);
                    assert_eq!(g[3], i[3], "alpha untouched");
                    (0..3)
                        .map(|c| (want[c] - g[c]).abs() / want[c].abs().max(1.0))
                        .fold(0.0_f32, f32::max)
                })
                .fold(0.0_f32, f32::max);
            eprintln!(
                "HSM WB parity {dims:?} srgb={srgb} w=({w_target}, {w_anchor}) gain {gain}: max diff {max_diff:e}"
            );
            assert!(
                max_diff < PARITY_TOLERANCE,
                "{dims:?} srgb={srgb} w=({w_target}, {w_anchor}): GPU vs raw-core {max_diff}"
            );
        }
    }
}

#[test]
fn wgsl_blends_cells_before_spatial_unwrap_like_a_fresh_develop() {
    use raw_core::color::hsm::{self, HsmEncoding, HsmTable};
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
    let flat: Vec<f32> = [2.0, 2.0, 1.0, 0.0, 2856.0, 6504.0]
        .into_iter()
        .chain(cold.data.iter().copied())
        .chain(warm.data.iter().copied())
        .collect();
    let view = HsmRetargetView::from_wire(&flat, 4100.0, 1.0).unwrap();
    let rgb: Vec<_> = [15.0, 45.0, 90.0, 135.0, 210.0, 315.0]
        .into_iter()
        .map(|h| hsm::hsv_to_rgb(h, 0.5, 0.8))
        .collect();
    let rgba: Vec<_> = rgb.iter().flat_map(|p| [p[0], p[1], p[2], 1.0]).collect();
    let ctx = GpuContext::new_blocking().expect("gpu context");
    let image = GpuImage::upload(&ctx, &rgba, rgb.len() as u32, 1);
    let runner = ChainRunner::new(&ctx, &image);
    let identity = Matrix3([[1.0, 0.0, 0.0], [0.0, 1.0, 0.0], [0.0, 0.0, 1.0]]);
    for t in [0.0, 0.25, 0.5, 0.75, 1.0] {
        let d = HsmLiveDelta {
            to_pro: identity,
            delta_pro: identity,
            from_pro: identity,
            w_target: t,
            w_anchor: 0.0,
            inverse_iterations: 0,
        };
        let hsm = inputs(&view, &d);
        let output = runner.run_blocking(&[&WhiteBalancePass {
            matrix: identity.0,
            hsm: Some(&hsm),
        }]);
        let blended = hsm::lerp_tables(&cold, &warm, t).unwrap();
        for (source, got) in rgb.iter().zip(output.chunks_exact(4)) {
            let want = hsm::apply_one(*source, &blended);
            for c in 0..3 {
                assert!(
                    (want[c] - got[c]).abs() < 1e-4,
                    "t={t}: {got:?} vs {want:?}"
                );
            }
        }
    }
}
