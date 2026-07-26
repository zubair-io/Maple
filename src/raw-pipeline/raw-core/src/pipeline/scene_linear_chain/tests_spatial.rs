//! Sharpen + nr_color in-chain tests (#1043), split out of `tests.rs` for
//! the 600-LOC file budget.
//!
//! The Apple shell used to re-apply these two post-AgX with its own Metal
//! kernels, so the chain skipped them. The kernels are gone; these tests
//! pin that the chain runs both, with the right parameters, in develop's
//! order (`vignette` -> `sharpen` -> `nr_luminance` -> `nr_color`).
use super::*;

fn edge_and_chroma_f32(w: u32, h: u32) -> Vec<f32> {
    let mut v = Vec::with_capacity((w * h * 4) as usize);
    for y in 0..h {
        for x in 0..w {
            let base = if x < w / 2 { 0.10 } else { 0.60 };
            let wobble = if (x + y) % 2 == 0 { 0.05 } else { -0.05 };
            v.push(base + wobble);
            v.push(base);
            v.push(base - wobble);
            v.push(1.0);
        }
    }
    v
}

/// Unpack the chain's f32 RGBA output into an `Image` so a manually
/// staged reference can be compared lane-for-lane.
fn image_from_f32_rgba(buf: &[f32], w: u32, h: u32) -> crate::image::Image {
    crate::image::Image {
        width: w,
        height: h,
        pixels: buf.chunks_exact(4).map(|c| [c[0], c[1], c[2]]).collect(),
        space: crate::image::ColorSpace::SceneLinearRec2020,
    }
}

/// With `skip_agx` every other stage at its default is identity, so the
/// chain's output must be exactly `sharpen::apply` then
/// `noise_reduction::apply_color` over the input — same parameters, same
/// order as `develop`.
#[test]
fn chain_f32_runs_sharpen_then_nr_color_like_develop() {
    let (w, h) = (16u32, 16u32);
    let input = edge_and_chroma_f32(w, h);
    let model = AdjustmentModel {
        sharpen_amount: 40.0,
        nr_color: 25.0,
        ..AdjustmentModel::default()
    };
    let out = apply_scene_linear_chain_f32(
        &input,
        w,
        h,
        &model,
        &ChainOptions {
            skip_agx: true,
            ..ChainOptions::default()
        },
    )
    .expect("chain with sharpen + nr_color");

    let mut expected = image_from_f32_rgba(&input, w, h);
    crate::stages::sharpen::apply(
        &mut expected,
        model.sharpen_amount,
        model.sharpen_radius,
        model.sharpen_detail,
        model.sharpen_masking,
    );
    crate::stages::noise_reduction::apply_color(&mut expected, model.nr_color, None, 100);

    for (i, p) in expected.pixels.iter().enumerate() {
        for (lane, &want) in p.iter().enumerate() {
            let got = out[i * 4 + lane];
            assert!(
                (got - want).abs() <= 1e-6,
                "pixel {} lane {}: chain {} != develop-order reference {}",
                i,
                lane,
                got,
                want
            );
        }
    }
}

/// The stages must actually do something — a guard against the chain
/// silently short-circuiting both and the test above comparing two
/// identities.
#[test]
fn chain_f32_sharpen_and_nr_color_are_not_no_ops() {
    let (w, h) = (16u32, 16u32);
    let input = edge_and_chroma_f32(w, h);
    let opts = ChainOptions {
        skip_agx: true,
        ..ChainOptions::default()
    };
    let off = apply_scene_linear_chain_f32(
        &input,
        w,
        h,
        &AdjustmentModel {
            sharpen_amount: 0.0,
            nr_color: 0.0,
            ..AdjustmentModel::default()
        },
        &opts,
    )
    .expect("chain with both stages off");
    let on = apply_scene_linear_chain_f32(
        &input,
        w,
        h,
        &AdjustmentModel {
            sharpen_amount: 40.0,
            nr_color: 25.0,
            ..AdjustmentModel::default()
        },
        &opts,
    )
    .expect("chain with both stages on");

    // Off is identity on this input (every remaining default stage
    // short-circuits under skip_agx).
    for (i, (&got, &want)) in off.iter().zip(input.iter()).enumerate() {
        assert!(
            (got - want).abs() <= 1e-6,
            "lane {}: stages-off chain must be identity ({} != {})",
            i,
            got,
            want
        );
    }
    let changed = on
        .iter()
        .zip(off.iter())
        .filter(|(a, b)| (**a - **b).abs() > 1e-4)
        .count();
    assert!(
        changed > 0,
        "sharpen + nr_color left the buffer untouched — the chain is not running them"
    );
}
