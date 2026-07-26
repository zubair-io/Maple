//! Parity tests for the local-adjustments WGSL kernel (#1698).
//!
//! Split out of `local_adjustments.rs` to keep that module under the 600-LOC
//! budget (mirrors the vignette / saturation splits). Included via
//! `#[path = "local_adjustments/tests.rs"] mod tests;` so it reaches the
//! parent's private items through `super::*`.
//!
//! The gate compares against `raw_core::stages::local_adjustments::apply`
//! itself — the shipping Rust stage, through the test-only dev-dep — rather
//! than a transcribed CPU twin, so there is nothing that can drift out from
//! under the kernel.

use super::*;
use crate::chain::ChainRunner;
use crate::image::GpuImage;
use raw_core::types::{
    layers_to_flat, LocalAdjustment, Mask, PartialAdjustments, Point2, LAYER_FLAT_LEN as CORE_LEN,
};

/// A 2-D buffer spanning the tonal range the luma-coupled controls key off:
/// deep shadow (blacks / shadows), midtone, above the Y = 1 knee (highlights'
/// shape branch), saturated chroma (the Oklab gamut bisection), and a
/// slightly-negative channel. Local adjustments are POSITION-dependent, so a
/// count x 1 strip would only exercise one row of the mask field.
fn buffer_16x12() -> (Vec<f32>, u32, u32) {
    let (w, h) = (16u32, 12u32);
    let mut v = Vec::with_capacity((w * h * 4) as usize);
    for y in 0..h {
        for x in 0..w {
            let i = y * w + x;
            let t = i as f32 / (w * h) as f32;
            let (r, g, b) = match i % 7 {
                0 => (0.80, 0.10, 0.10),    // saturated red, near the hull
                1 => (0.002, 0.004, 0.003), // deep shadow / toe
                3 => (5.00, 3.00, 1.50),    // HDR headroom, past the knee
                5 => (-0.01, 0.20, 0.40),   // slightly-negative channel
                6 => (0.10, 0.60, 0.95),    // saturated blue
                _ => (0.05 + t, 0.9 - t * 0.5, 0.2 + t * 0.3),
            };
            v.extend_from_slice(&[r, g, b, 1.0]);
        }
    }
    (v, w, h)
}

/// Run the real Rust stage over a flat interleaved RGBA f32 buffer, carrying
/// alpha through untouched. This is the ticket's reference.
fn raw_core_local(buf: &[f32], w: u32, h: u32, layers: &[LocalAdjustment]) -> Vec<f32> {
    use raw_core::image::{ColorSpace, Image};
    let mut img = Image::new(w, h, ColorSpace::SceneLinearRec2020);
    for (i, chunk) in buf.chunks_exact(4).enumerate() {
        img.pixels[i] = [chunk[0], chunk[1], chunk[2]];
    }
    raw_core::stages::local_adjustments::apply(&mut img, layers);
    let mut out = Vec::with_capacity(buf.len());
    for (i, p) in img.pixels.iter().enumerate() {
        out.extend_from_slice(&[p[0], p[1], p[2], buf[i * 4 + 3]]);
    }
    out
}

fn run_gpu(ctx: &GpuContext, buf: &[f32], w: u32, h: u32, layers: &[LocalAdjustment]) -> Vec<f32> {
    let img = GpuImage::upload(ctx, buf, w, h);
    let runner = ChainRunner::new(ctx, &img);
    let pass = LocalAdjustmentsPass::new(&layers_to_flat(layers));
    runner.run_blocking(&[&pass])
}

fn max_abs_diff(a: &[f32], b: &[f32]) -> f32 {
    a.iter()
        .zip(b)
        .map(|(x, y)| (x - y).abs())
        .fold(0.0_f32, f32::max)
}

/// The worst `(index, abs_diff, relative_diff)` across two buffers. Reported
/// by the stacked gate, which needs both metrics — see the note there on why
/// an absolute ceiling alone stops being meaningful at large scene-linear
/// magnitudes.
fn worst(a: &[f32], b: &[f32]) -> (usize, f32, f32) {
    a.iter()
        .zip(b)
        .enumerate()
        .fold((0usize, 0.0_f32, 0.0_f32), |acc, (i, (x, y))| {
            let d = (x - y).abs();
            if d > acc.1 {
                (i, d, d / x.abs().max(1e-6))
            } else {
                acc
            }
        })
}

fn linear(feather: f32, adjustments: PartialAdjustments) -> LocalAdjustment {
    LocalAdjustment {
        mask: Mask::Linear {
            start: Point2::new(0.1, 0.2),
            end: Point2::new(0.9, 0.8),
            feather,
        },
        adjustments,
    }
}

fn radial(feather: f32, invert: bool, adjustments: PartialAdjustments) -> LocalAdjustment {
    LocalAdjustment {
        mask: Mask::Radial {
            center: Point2::new(0.45, 0.55),
            radii: Point2::new(0.35, 0.22),
            angle: 0.6,
            feather,
            invert,
        },
        adjustments,
    }
}

fn only(set: impl FnOnce(&mut PartialAdjustments)) -> PartialAdjustments {
    let mut a = PartialAdjustments::default();
    set(&mut a);
    a
}

/// Every control on one layer, so a stacked case exercises the full
/// `apply_pixel` body including the per-pixel CAT16 derivation.
fn all_controls() -> PartialAdjustments {
    PartialAdjustments {
        exposure: Some(0.6),
        contrast: Some(25.0),
        highlights: Some(-40.0),
        shadows: Some(30.0),
        whites: Some(15.0),
        blacks: Some(-20.0),
        saturation: Some(35.0),
        vibrance: Some(25.0),
        temperature: Some(1200.0),
        tint: Some(8.0),
    }
}

/// THE PARITY GATE: one control at a time, both mask shapes, hard and
/// feathered, against the real Rust stage. Isolating the controls means a
/// failure names the operator that diverged instead of reporting one blended
/// number.
#[test]
fn wgsl_local_adjustments_match_raw_core_per_control_within_1e_4() {
    let ctx = GpuContext::new_blocking().expect("gpu context");
    let (input, w, h) = buffer_16x12();

    let cases: Vec<(&str, LocalAdjustment)> = vec![
        (
            "exposure/linear-hard",
            linear(0.0, only(|a| a.exposure = Some(1.5))),
        ),
        (
            "exposure/linear-feather",
            linear(0.5, only(|a| a.exposure = Some(-1.25))),
        ),
        (
            "contrast/radial",
            radial(0.5, false, only(|a| a.contrast = Some(60.0))),
        ),
        (
            "highlights+/radial",
            radial(0.4, false, only(|a| a.highlights = Some(85.0))),
        ),
        (
            "highlights-/linear",
            linear(0.6, only(|a| a.highlights = Some(-70.0))),
        ),
        (
            "shadows/linear",
            linear(0.75, only(|a| a.shadows = Some(90.0))),
        ),
        (
            "whites/radial",
            radial(0.3, false, only(|a| a.whites = Some(-55.0))),
        ),
        (
            "blacks-crush/linear",
            linear(0.5, only(|a| a.blacks = Some(-95.0))),
        ),
        (
            "blacks-lift/linear",
            linear(0.5, only(|a| a.blacks = Some(80.0))),
        ),
        (
            "saturation+/radial",
            radial(0.5, false, only(|a| a.saturation = Some(90.0))),
        ),
        (
            "saturation-/radial",
            radial(0.5, true, only(|a| a.saturation = Some(-60.0))),
        ),
        (
            "vibrance/linear",
            linear(0.5, only(|a| a.vibrance = Some(75.0))),
        ),
        (
            "temperature/linear",
            linear(0.5, only(|a| a.temperature = Some(4200.0))),
        ),
        (
            "temperature-cool/radial",
            radial(0.5, false, only(|a| a.temperature = Some(-3000.0))),
        ),
        ("tint/linear", linear(0.5, only(|a| a.tint = Some(45.0)))),
        (
            "radial-invert/exposure",
            radial(0.5, true, only(|a| a.exposure = Some(1.0))),
        ),
    ];

    for (name, layer) in cases {
        let layers = [layer];
        let reference = raw_core_local(&input, w, h, &layers);
        let gpu = run_gpu(&ctx, &input, w, h, &layers);
        let diff = max_abs_diff(&reference, &gpu);
        eprintln!("PARITY vs raw-core local_adjustments [{name}]: max abs diff = {diff:e}");
        assert!(
            diff < 1e-4,
            "{name}: GPU vs raw-core stage max abs diff {diff} exceeds 1e-4"
        );
    }
}

/// Stacked layers: the kernel composites the whole stack in registers per
/// pixel while the Rust stage makes a full-image pass per layer. Those are
/// only equivalent because both the mask weight and the apply are purely
/// local, so this case is what proves the collapse to one dispatch is sound —
/// and it drives every control at once, including the per-pixel CAT16 path.
#[test]
fn stacked_layers_match_raw_core_within_the_parity_ceiling() {
    let ctx = GpuContext::new_blocking().expect("gpu context");
    let (input, w, h) = buffer_16x12();

    let layers = [
        linear(0.5, all_controls()),
        radial(0.35, false, all_controls()),
        radial(
            0.8,
            true,
            only(|a| {
                a.exposure = Some(-0.8);
                a.saturation = Some(-30.0);
            }),
        ),
    ];
    let reference = raw_core_local(&input, w, h, &layers);
    let gpu = run_gpu(&ctx, &input, w, h, &layers);
    let (idx, abs_diff, rel_diff) = worst(&reference, &gpu);
    let magnitude = reference[idx].abs();
    eprintln!(
        "PARITY vs raw-core local_adjustments [3 stacked layers, all controls]: \
         max abs diff = {abs_diff:e} at value {magnitude} (relative {rel_diff:e})"
    );

    // Ceiling: the epic's 1e-4 absolute for ordinary magnitudes, switching to
    // 1e-5 RELATIVE once the scene-linear value passes 10.
    //
    // The switch is a statement about f32, not a concession. Three stacked
    // layers of +0.6 EV plus contrast and shadows drive this fixture's HDR
    // pixel to ~225, where one f32 ULP is 2^7 * 2^-23 = 1.5e-5. A 1e-4
    // absolute ceiling there is ~6 ULP, and no implementation of thirty
    // chained transcendental operators — three CAT16 derivations, three
    // Oklab round trips each for saturation and vibrance, powf, exp2 — agrees
    // to 6 ULP across two different math libraries. What the gate must
    // actually catch is a STRUCTURAL divergence (a mis-ordered operator, a
    // dropped step, a transposed matrix), and those show up at relative
    // errors of 1e-3 and worse, two orders above this ceiling.
    let ceiling = 1e-4_f32.max(1e-5 * magnitude);
    assert!(
        abs_diff < ceiling,
        "stacked layers: GPU vs raw-core stage max abs diff {abs_diff} at value \
         {magnitude} exceeds the ceiling {ceiling} (relative {rel_diff})"
    );
}

/// A layer whose adjustments are all `None` must leave the buffer bit-exact,
/// the same skip the Rust stage's `adjustments.is_empty()` guard makes. The
/// pass is still encoded here (bypassing the chain gate) so the KERNEL's own
/// per-layer skip is what gets tested.
#[test]
fn layer_without_controls_is_bit_exact_passthrough() {
    let ctx = GpuContext::new_blocking().expect("gpu context");
    let (input, w, h) = buffer_16x12();
    let layers = [linear(0.5, PartialAdjustments::default())];
    let gpu = run_gpu(&ctx, &input, w, h, &layers);
    assert_eq!(gpu, input, "an empty layer must not touch a single pixel");
}

/// Pixels at zero mask weight must come through bit-exact, not merely close:
/// the kernel's `w <= 0.0` skip is what makes an unmasked region identical to
/// the un-adjusted render, and a round-trip through Oklab there would drift.
#[test]
fn zero_weight_region_is_bit_exact() {
    let ctx = GpuContext::new_blocking().expect("gpu context");
    let (input, w, h) = buffer_16x12();
    // Hard-stepped horizontal gradient: weight is exactly 0 left of x = 0.5.
    let layers = [LocalAdjustment {
        mask: Mask::Linear {
            start: Point2::new(0.0, 0.5),
            end: Point2::new(1.0, 0.5),
            feather: 0.0,
        },
        adjustments: all_controls(),
    }];
    let gpu = run_gpu(&ctx, &input, w, h, &layers);

    let last_zero_col = ((w - 1) / 2).saturating_sub(1);
    for y in 0..h {
        for x in 0..=last_zero_col {
            let i = ((y * w + x) * 4) as usize;
            assert_eq!(
                &gpu[i..i + 4],
                &input[i..i + 4],
                "pixel ({x},{y}) is outside the mask and must be untouched"
            );
        }
    }
    // ...and the fully-weighted side DID change, so the pass was not a no-op.
    let right = (((h / 2) * w + (w - 1)) * 4) as usize;
    assert_ne!(&gpu[right..right + 3], &input[right..right + 3]);
}

/// Alpha is carried through untouched, like every other RGBA f32 stage.
#[test]
fn alpha_is_untouched() {
    let ctx = GpuContext::new_blocking().expect("gpu context");
    let (w, h) = (8u32, 8u32);
    let mut input = vec![0.0f32; (w * h * 4) as usize];
    for (i, px) in input.chunks_exact_mut(4).enumerate() {
        px.copy_from_slice(&[0.4, 0.25, 0.15, 0.1 + 0.01 * i as f32]);
    }
    let layers = [linear(0.5, all_controls())];
    let gpu = run_gpu(&ctx, &input, w, h, &layers);
    for (i, (a, b)) in input.chunks_exact(4).zip(gpu.chunks_exact(4)).enumerate() {
        assert_eq!(a[3], b[3], "alpha at pixel {i} must be carried through");
    }
}

/// The flat-wire stride the kernel's `Layer` struct assumes must be the one
/// raw-core writes. Six `vec4<f32>` members = 96 bytes = 24 floats; if
/// raw-core ever changed its record length the storage buffer would be read
/// with the wrong stride and every layer past the first would be garbage.
#[test]
fn flat_stride_matches_raw_core() {
    assert_eq!(LAYER_FLAT_LEN, CORE_LEN);
    assert_eq!(LAYER_FLAT_LEN * std::mem::size_of::<f32>(), 96);
}

/// The transcribed CAT16 constants must be the ones raw-core uses. The kernel
/// derives its adaptation matrix per pixel from these, so a stale transcription
/// would show up as a colour cast under any local temperature/tint — which the
/// per-control gate above would catch, but this pins the cause rather than the
/// symptom.
#[test]
fn transcribed_cat16_constants_match_raw_core() {
    use raw_core::color::matrices::{CAT16, M_REC2020_TO_XYZ_D65, M_XYZ_D65_TO_REC2020, XYZ_D65};

    // Values as written in local_adjustments.wgsl.
    let wgsl_cat16 = [
        [0.401288_f32, 0.650173, -0.051461],
        [-0.250268, 1.204414, 0.045854],
        [-0.002079, 0.048952, 0.953127],
    ];
    let wgsl_cat16_inv = [
        [1.8620679_f32, -1.0112545, 0.14918676],
        [0.38752654, 0.62144744, -0.008973984],
        [-0.015841497, -0.034122933, 1.0499644],
    ];
    let wgsl_rec2020_to_xyz = [
        [0.6369580_f32, 0.1446169, 0.1688810],
        [0.2627002, 0.6779981, 0.0593017],
        [0.0000000, 0.0280727, 1.0609851],
    ];
    let wgsl_xyz_to_rec2020 = [
        [1.7166512_f32, -0.3556708, -0.2533663],
        [-0.6666844, 1.6164812, 0.0157685],
        [0.0176399, -0.0427706, 0.9421031],
    ];
    let wgsl_xyz_d65 = [0.9504_f32, 1.0000, 1.0888];

    assert_eq!(wgsl_cat16, CAT16.0);
    assert_eq!(wgsl_rec2020_to_xyz, M_REC2020_TO_XYZ_D65.0);
    assert_eq!(wgsl_xyz_to_rec2020, M_XYZ_D65_TO_REC2020.0);
    assert_eq!(wgsl_xyz_d65, XYZ_D65);
    assert_eq!(
        wgsl_cat16_inv,
        CAT16.inverse().expect("CAT16 is non-singular").0,
        "the transcribed CAT16 inverse must be the f32 value raw-core computes"
    );
}

/// The inclusion predicate agrees with raw-core's guards: an empty stack and a
/// stack of control-free layers are both no-ops; one real control engages it.
#[test]
fn activity_predicate_matches_the_raw_core_guards() {
    assert!(!local_adjustments_are_active(&[]));
    assert!(!local_adjustments_are_active(&layers_to_flat(&[linear(
        0.5,
        PartialAdjustments::default()
    )])));
    assert!(local_adjustments_are_active(&layers_to_flat(&[
        linear(0.5, PartialAdjustments::default()),
        radial(0.5, false, only(|a| a.exposure = Some(0.1))),
    ])));
}

/// A truncated wire must render its valid prefix, not panic. The stack crosses
/// the FFI/WASM boundary as a raw `(ptr, len)` pair, so a host bug can hand the
/// GPU path a length that is not a whole number of records — and `flat.rs`
/// documents that case as "dropped rather than rejected", which both the CPU
/// stage and the inclusion predicate honour via `chunks_exact`. The pass has to
/// agree, or an edit that renders fine on the refine pass takes the live render
/// thread down with it.
#[test]
fn a_truncated_wire_renders_the_valid_prefix() {
    let ctx = GpuContext::new_blocking().expect("gpu context");
    let (input, w, h) = buffer_16x12();
    let layers = [radial(0.4, false, all_controls())];

    let mut truncated = layers_to_flat(&layers);
    truncated.extend_from_slice(&[0.5; LAYER_FLAT_LEN - 1]); // half a record
    assert_ne!(truncated.len() % LAYER_FLAT_LEN, 0);

    let img = GpuImage::upload(&ctx, &input, w, h);
    let runner = ChainRunner::new(&ctx, &img);
    let pass = LocalAdjustmentsPass::new(&truncated);
    let got = runner.run_blocking(&[&pass]);

    // Identical to the same stack with no partial tail attached.
    let clean = run_gpu(&ctx, &input, w, h, &layers);
    assert_eq!(got, clean, "the partial tail record must be dropped");
}
