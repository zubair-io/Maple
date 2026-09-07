//! Parity tests for the per-mask SPATIAL control group (#3407).
//!
//! Split out of `local_spatial.rs` for the 600-LOC budget, same shape as
//! `local_adjustments/tests.rs`. The oracle is the real
//! `raw_core::stages::local_adjustments::apply` through the test-only
//! dev-dep — the shipping Rust stage, spatial group and all — so there is no
//! transcribed CPU twin that could drift out from under the GPU passes.

use super::*;
use crate::chain::ChainRunner;
use crate::dehaze::compute_airlight;
use crate::image::GpuImage;
use crate::local_adjustments::local_adjustments_need_spatial;
use raw_core::types::{layers_to_flat, LocalAdjustment, Mask, PartialAdjustments, Point2};

/// A 48×40 buffer with real spatial structure: a bright/dark checker at two
/// scales plus a saturated fringe column, so the guided filters, the unsharp
/// mask, the NLM search window and the defringe edge detector all have
/// something to bite on. The spatial kernels are neighbourhood reads, so a
/// flat field would make every one of them vacuous.
fn structured_buffer() -> (Vec<f32>, u32, u32) {
    let (w, h) = (48u32, 40u32);
    let mut v = Vec::with_capacity((w * h * 4) as usize);
    for y in 0..h {
        for x in 0..w {
            let coarse: f32 = if ((x / 8) + (y / 8)) % 2 == 0 {
                0.7
            } else {
                0.12
            };
            let fine: f32 = if (x + y) % 3 == 0 { 0.06 } else { -0.03 };
            let base = f32::max(coarse + fine, 0.005);
            // A saturated magenta column against the coarse edge at x = 16 —
            // the defringe detector's target. x = 40 carries HDR headroom so
            // the gate sees a large-magnitude pixel too.
            let rgb = if x == 16 {
                [base * 1.4, base * 0.25, base * 1.35]
            } else if x == 40 {
                [base * 6.0, base * 5.0, base * 4.0]
            } else {
                [base, base * 0.95, base * 1.05]
            };
            v.extend_from_slice(&[rgb[0], rgb[1], rgb[2], 1.0]);
        }
    }
    (v, w, h)
}

/// A feathered radial layer carrying `adjustments` — a mask with a genuine
/// gradient, so the blend is exercised at partial weights rather than only at
/// 0 and 1.
fn radial(adjustments: PartialAdjustments) -> LocalAdjustment {
    LocalAdjustment {
        mask: Mask::Radial {
            center: Point2::new(0.45, 0.55),
            radii: Point2::new(0.35, 0.28),
            angle: 0.0,
            feather: 0.5,
            invert: false,
        },
        range: None,
        adjustments,
    }
}

fn only(set: impl FnOnce(&mut PartialAdjustments)) -> PartialAdjustments {
    let mut a = PartialAdjustments::default();
    set(&mut a);
    a
}

/// The reference: the real Rust stage over a flat interleaved RGBA buffer,
/// alpha carried through untouched.
fn raw_core_local(buf: &[f32], w: u32, h: u32, layers: &[LocalAdjustment]) -> Vec<f32> {
    use raw_core::image::{ColorSpace, Image};
    let mut img = Image::new(w, h, ColorSpace::SceneLinearRec2020);
    for (i, chunk) in buf.chunks_exact(4).enumerate() {
        img.pixels[i] = [chunk[0], chunk[1], chunk[2]];
    }
    raw_core::stages::local_adjustments::apply(&mut img, layers, &[]);
    let mut out = Vec::with_capacity(buf.len());
    for (i, p) in img.pixels.iter().enumerate() {
        out.extend_from_slice(&[p[0], p[1], p[2], buf[i * 4 + 3]]);
    }
    out
}

fn run_gpu(ctx: &GpuContext, buf: &[f32], w: u32, h: u32, pass: &LocalSpatialPass) -> Vec<f32> {
    let img = GpuImage::upload(ctx, buf, w, h);
    let runner = ChainRunner::new(ctx, &img);
    runner.run_blocking(&[pass])
}

/// Build the pass for a single layer, with the dehaze sub-pass's airlight
/// pinned to the CPU value of `buf`.
///
/// The layers this helper is used with set no POINT controls, so the buffer
/// their dehaze would measure IS `buf` — the same buffer raw-core's own
/// dehaze measures. Pinning it keeps the on-GPU airlight reduction (a
/// histogram approximation with its own gate) out of what this file claims.
fn pass_for(layer: &LocalAdjustment, buf: &[f32], w: u32, h: u32) -> LocalSpatialPass {
    LocalSpatialPass::new(&layers_to_flat(std::slice::from_ref(layer)), &[], false).with_airlight(
        AirlightSource::Cpu(compute_airlight(buf, w as usize, h as usize)),
    )
}

/// The worst `(index, abs_diff)` across two buffers.
fn worst(a: &[f32], b: &[f32]) -> (usize, f32) {
    a.iter()
        .zip(b)
        .enumerate()
        .fold((0usize, 0.0_f32), |acc, (i, (x, y))| {
            let d = (x - y).abs();
            if d > acc.1 {
                (i, d)
            } else {
                acc
            }
        })
}

/// The parity ceiling this file uses: the epic's 1e-4 absolute for ordinary
/// scene-linear magnitudes, relaxing to 1e-5 relative past ~10, for the same
/// f32-ULP reason `local_adjustments/tests.rs`'s stacked gate documents.
fn assert_parity(name: &str, reference: &[f32], gpu: &[f32]) {
    let (idx, abs_diff) = worst(reference, gpu);
    let magnitude = reference[idx].abs();
    let ceiling = 1e-4_f32.max(1e-5 * magnitude);
    eprintln!(
        "PARITY vs raw-core local spatial [{name}]: max abs diff = {abs_diff:e} \
         at value {magnitude} (ceiling {ceiling:e})"
    );
    assert!(
        abs_diff < ceiling,
        "{name}: GPU vs raw-core max abs diff {abs_diff} at value {magnitude} \
         exceeds the ceiling {ceiling}"
    );
}

#[test]
fn spatial_controls_decode_from_the_flat_record() {
    let layer = radial(PartialAdjustments {
        texture: Some(18.0),
        clarity: Some(-24.0),
        dehaze: Some(31.0),
        sharpness: Some(66.0),
        luminance_noise: Some(40.0),
        defringe: Some(75.0),
        ..Default::default()
    });
    let flat = layers_to_flat(&[layer]);
    let controls = SpatialControls::from_flat(&flat);
    assert_eq!(
        controls,
        SpatialControls {
            texture: Some(18.0),
            clarity: Some(-24.0),
            dehaze: Some(31.0),
            sharpness: Some(66.0),
            luminance_noise: Some(40.0),
            defringe: Some(75.0),
        }
    );
    assert!(controls.engaged());
    assert!(layer_needs_spatial(&flat));
    assert!(local_adjustments_need_spatial(&flat));
}

#[test]
fn an_absent_control_decodes_to_none_not_zero() {
    let flat = layers_to_flat(&[radial(only(|a| a.clarity = Some(0.0)))]);
    let controls = SpatialControls::from_flat(&flat);
    assert_eq!(controls.clarity, Some(0.0));
    assert_eq!(controls.texture, None);
    assert_eq!(controls.defringe, None);
    // A control pinned at zero is present on the wire but does nothing…
    assert!(!controls.engaged());
    // …and the record still reports as needing the split chain shape, since
    // presence — not magnitude — is what the flat wire carries.
    assert!(layer_needs_spatial(&flat));
}

#[test]
fn a_point_only_layer_needs_no_spatial_pass() {
    let flat = layers_to_flat(&[radial(only(|a| a.exposure = Some(1.0)))]);
    assert!(!layer_needs_spatial(&flat));
    assert!(!SpatialControls::from_flat(&flat).engaged());
    assert!(!local_adjustments_need_spatial(&flat));
}

/// THE PARITY GATE: one spatial control at a time against the real Rust
/// stage. Isolating them means a failure names the kernel that diverged
/// instead of reporting one blended number.
#[test]
fn wgsl_local_spatial_matches_raw_core_per_control() {
    let ctx = GpuContext::new_blocking().expect("gpu context");
    let (input, w, h) = structured_buffer();

    let cases: Vec<(&str, LocalAdjustment)> = vec![
        ("texture", radial(only(|a| a.texture = Some(60.0)))),
        ("clarity", radial(only(|a| a.clarity = Some(45.0)))),
        (
            "clarity-negative",
            radial(only(|a| a.clarity = Some(-45.0))),
        ),
        ("dehaze", radial(only(|a| a.dehaze = Some(40.0)))),
        ("sharpness", radial(only(|a| a.sharpness = Some(70.0)))),
        (
            "luminance-noise",
            radial(only(|a| a.luminance_noise = Some(60.0))),
        ),
        ("defringe", radial(only(|a| a.defringe = Some(80.0)))),
    ];

    for (name, layer) in cases {
        let reference = raw_core_local(&input, w, h, std::slice::from_ref(&layer));
        let gpu = run_gpu(&ctx, &input, w, h, &pass_for(&layer, &input, w, h));
        assert_parity(name, &reference, &gpu);
    }
}

/// All six at once, plus point controls, on one layer: proves the kernels run
/// in the order the Rust stage runs them and that the point group lands
/// before the spatial group.
#[test]
fn every_spatial_control_together_matches_raw_core() {
    let ctx = GpuContext::new_blocking().expect("gpu context");
    let (input, w, h) = structured_buffer();
    let layer = radial(PartialAdjustments {
        exposure: Some(0.4),
        shadows: Some(20.0),
        texture: Some(35.0),
        clarity: Some(30.0),
        sharpness: Some(50.0),
        luminance_noise: Some(30.0),
        defringe: Some(60.0),
        ..Default::default()
    });
    // Dehaze is deliberately absent here: this layer DOES set point controls,
    // so the buffer its dehaze would measure is the point-applied one, not
    // `input`, and a CPU airlight of `input` would be the wrong number. The
    // dehaze kernel is gated on its own in the per-control case above.
    let reference = raw_core_local(&input, w, h, std::slice::from_ref(&layer));
    let flat = layers_to_flat(std::slice::from_ref(&layer));
    let pass = LocalSpatialPass::new(&flat, &[], false);
    let gpu = run_gpu(&ctx, &input, w, h, &pass);
    assert_parity("all-six-plus-point", &reference, &gpu);
}

/// Pixels the mask does not reach come through BIT-EXACT, not merely close.
/// A spatial kernel runs over the whole buffer, so without the blend's
/// `w <= 0` guard the unmasked region would carry the kernel's own float
/// noise everywhere — which is exactly the bug that would make a mask behave
/// like a global slider.
#[test]
fn pixels_outside_the_mask_are_bit_exact() {
    let ctx = GpuContext::new_blocking().expect("gpu context");
    let (input, w, h) = structured_buffer();
    // A small hard-edged radial in the middle: the frame's corners sit far
    // outside it, at weight exactly 0.
    let layer = LocalAdjustment {
        mask: Mask::Radial {
            center: Point2::new(0.5, 0.5),
            radii: Point2::new(0.15, 0.15),
            angle: 0.0,
            feather: 0.0,
            invert: false,
        },
        range: None,
        adjustments: PartialAdjustments {
            clarity: Some(80.0),
            texture: Some(80.0),
            sharpness: Some(80.0),
            ..Default::default()
        },
    };
    let flat = layers_to_flat(std::slice::from_ref(&layer));
    let gpu = run_gpu(
        &ctx,
        &input,
        w,
        h,
        &LocalSpatialPass::new(&flat, &[], false),
    );

    let corners = [
        0usize,
        (w - 1) as usize,
        ((h - 1) * w) as usize,
        (w * h - 1) as usize,
    ];
    for i in corners {
        assert_eq!(
            &gpu[i * 4..i * 4 + 4],
            &input[i * 4..i * 4 + 4],
            "corner pixel {i} sits at mask weight 0 and must be untouched"
        );
    }
    assert_ne!(
        gpu, input,
        "the masked interior must actually have changed, or this test is vacuous"
    );
}

/// Alpha is the vectorscope's channel (#3272). A non-target layer must hand
/// back the alpha it was given; the target layer replaces it with its own
/// per-pixel mask weight.
#[test]
fn alpha_is_restored_unless_this_layer_is_the_scope_target() {
    let ctx = GpuContext::new_blocking().expect("gpu context");
    let (input, w, h) = structured_buffer();
    let layer = radial(only(|a| a.clarity = Some(50.0)));
    let flat = layers_to_flat(std::slice::from_ref(&layer));

    let plain = run_gpu(
        &ctx,
        &input,
        w,
        h,
        &LocalSpatialPass::new(&flat, &[], false),
    );
    for i in 0..(w * h) as usize {
        assert_eq!(
            plain[i * 4 + 3],
            input[i * 4 + 3],
            "alpha at pixel {i} must be carried through"
        );
    }

    let scoped = run_gpu(&ctx, &input, w, h, &LocalSpatialPass::new(&flat, &[], true));
    let centre = ((h / 2) * w + w / 2) as usize;
    assert!(
        (scoped[centre * 4 + 3] - 1.0).abs() < 1e-6,
        "the mask centre's weight is 1: got {}",
        scoped[centre * 4 + 3]
    );
    assert_eq!(
        scoped[3], 0.0,
        "the top-left corner sits outside the mask, weight 0"
    );
}

/// A layer whose spatial controls are all pinned at zero must leave the
/// buffer bit-exact — the blend degenerates to an identity lerp and no
/// kernel runs.
#[test]
fn zeroed_spatial_controls_are_a_bit_exact_passthrough() {
    let ctx = GpuContext::new_blocking().expect("gpu context");
    let (input, w, h) = structured_buffer();
    let layer = radial(PartialAdjustments {
        clarity: Some(0.0),
        texture: Some(0.0),
        ..Default::default()
    });
    let flat = layers_to_flat(std::slice::from_ref(&layer));
    let gpu = run_gpu(
        &ctx,
        &input,
        w,
        h,
        &LocalSpatialPass::new(&flat, &[], false),
    );
    assert_eq!(gpu, input, "a zeroed spatial group must not touch a pixel");
}
