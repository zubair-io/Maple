//! Unit tests for `scene_linear_chain`. Split into this submodule to stay
//! under the 600-LOC file budget (#1181).
use super::*;
use crate::view::encode::TargetPrimaries;

/// `apply_scene_linear_chain` over a default model is the AgX-only
/// transform (every other stage short-circuits at default values). On
/// a flat mid-gray input the output should be a constant non-zero
/// post-AgX value (no NaN, no negative).
#[test]
fn apply_scene_linear_chain_default_model_yields_agx_only() {
    let w = 4u32;
    let h = 4u32;
    let pixels = (w * h) as usize;
    let g = f32_to_f16_bits(0.18);
    let one = f32_to_f16_bits(1.0);
    let mut input: Vec<u16> = Vec::with_capacity(pixels * 4);
    for _ in 0..pixels {
        input.push(g);
        input.push(g);
        input.push(g);
        input.push(one);
    }
    let model = AdjustmentModel::default();
    let out = apply_scene_linear_chain(
        &input,
        w,
        h,
        &model,
        6500.0,
        0.0,
        false,
        TargetPrimaries::Srgb,
    )
    .expect("apply_scene_linear_chain default-model");
    assert_eq!(out.len(), input.len());
    let r = f16_bits_to_f32(out[0]);
    let g_out = f16_bits_to_f32(out[1]);
    let b = f16_bits_to_f32(out[2]);
    let a = f16_bits_to_f32(out[3]);
    assert!(r > 0.0 && r < 1.0, "R out of [0,1]: {}", r);
    assert!(g_out > 0.0 && g_out < 1.0, "G out of [0,1]: {}", g_out);
    assert!(b > 0.0 && b < 1.0, "B out of [0,1]: {}", b);
    assert!((a - 1.0).abs() < 1e-3, "alpha must be 1.0: {}", a);
    assert!((r - g_out).abs() < 1e-3, "R != G: {} vs {}", r, g_out);
    assert!((g_out - b).abs() < 1e-3, "G != B: {} vs {}", g_out, b);
}

/// `skip_agx` keeps the buffer in scene-linear domain — mid-gray
/// 0.18 stays 0.18 (modulo fp16 rounding).
#[test]
fn apply_scene_linear_chain_skip_agx_preserves_scene_linear() {
    let w = 4u32;
    let h = 4u32;
    let pixels = (w * h) as usize;
    let g = f32_to_f16_bits(0.18);
    let one = f32_to_f16_bits(1.0);
    let mut input: Vec<u16> = Vec::with_capacity(pixels * 4);
    for _ in 0..pixels {
        input.push(g);
        input.push(g);
        input.push(g);
        input.push(one);
    }
    let model = AdjustmentModel::default();
    let out = apply_scene_linear_chain(
        &input,
        w,
        h,
        &model,
        6500.0,
        0.0,
        true,
        TargetPrimaries::Srgb,
    )
    .expect("apply_scene_linear_chain skip_agx");
    let r = f16_bits_to_f32(out[0]);
    // Default model = identity for every cheap stage. With skip_agx
    // we expect input ≈ output (modulo fp16 round-trip).
    assert!(
        (r - 0.18).abs() < 0.01,
        "skip_agx default-model should be identity at scene-linear, got R={}",
        r
    );
}

/// Length mismatch surfaces as a Pipeline error, not a panic.
#[test]
fn apply_scene_linear_chain_rejects_size_mismatch() {
    let model = AdjustmentModel::default();
    let bogus_input = vec![0u16; 10];
    let r = apply_scene_linear_chain(
        &bogus_input,
        4,
        4,
        &model,
        6500.0,
        0.0,
        false,
        TargetPrimaries::Srgb,
    );
    assert!(r.is_err(), "size mismatch must error");
}

/// Defense-in-depth: `width * height` and the subsequent `* 4` are both
/// computed with `checked_mul`, so a width/height pair whose RGBA byte
/// length overflows `usize` on 64-bit returns a Pipeline error rather
/// than wrapping to a nonsense buffer size. Pre-existing bug surfaced by
/// Copilot review on #159.
#[test]
fn apply_scene_linear_chain_rgba_length_overflow_errors() {
    let model = AdjustmentModel::default();
    // u32::MAX * u32::MAX as u128 is 0xFFFFFFFE00000001 — this fits in
    // usize on 64-bit (usize::MAX = 0xFFFFFFFFFFFFFFFF). The reliable
    // overflow happens on the next step: `pixel_count * 4` for the RGBA
    // byte length, which the impl also guards with checked_mul.
    let r = apply_scene_linear_chain(
        &[],
        u32::MAX,
        u32::MAX,
        &model,
        6500.0,
        0.0,
        false,
        TargetPrimaries::Srgb,
    );
    match r {
        Err(crate::error::Error::Pipeline(msg)) => {
            assert!(
                msg.contains("overflow"),
                "expected overflow message, got: {msg}"
            );
        }
        other => panic!("expected Pipeline overflow error, got: {other:?}"),
    }
}

/// f32 sibling: default-model + skip_agx is identity at scene-linear.
/// The fp16 sibling test for the same property uses a ±0.01 tolerance
/// to absorb the fp16 round-trip; here we expect a much tighter match
/// (f32 identity for every cheap-stage at default values).
#[test]
fn apply_scene_linear_chain_f32_skip_agx_is_identity_on_default_model() {
    let w = 4u32;
    let h = 4u32;
    let pixels = (w * h) as usize;
    let mut input: Vec<f32> = Vec::with_capacity(pixels * 4);
    for _ in 0..pixels {
        input.push(0.18);
        input.push(0.18);
        input.push(0.18);
        input.push(1.0);
    }
    let model = AdjustmentModel::default();
    let out = apply_scene_linear_chain_f32(
        &input,
        w,
        h,
        &model,
        6500.0,
        0.0,
        true,
        TargetPrimaries::Srgb,
    )
    .expect("apply_scene_linear_chain_f32 skip_agx default-model");
    assert_eq!(out.len(), input.len());
    // Default model is identity at every cheap stage; with skip_agx the
    // output is the input verbatim modulo f32 rounding noise.
    assert!((out[0] - 0.18).abs() < 1e-5, "R drift: {} != 0.18", out[0]);
    assert!((out[1] - 0.18).abs() < 1e-5, "G drift: {} != 0.18", out[1]);
    assert!((out[2] - 0.18).abs() < 1e-5, "B drift: {} != 0.18", out[2]);
    assert!((out[3] - 1.0).abs() < 1e-6, "alpha must be 1.0: {}", out[3]);
}

/// f32 sibling: default-model with AgX engaged yields the same achromatic
/// post-AgX gray that the fp16 sibling does. Cross-checks that the
/// f32 path doesn't accidentally take a different code branch.
#[test]
fn apply_scene_linear_chain_f32_default_model_yields_agx_only() {
    let w = 4u32;
    let h = 4u32;
    let pixels = (w * h) as usize;
    let mut input: Vec<f32> = Vec::with_capacity(pixels * 4);
    for _ in 0..pixels {
        input.push(0.18);
        input.push(0.18);
        input.push(0.18);
        input.push(1.0);
    }
    let model = AdjustmentModel::default();
    let out = apply_scene_linear_chain_f32(
        &input,
        w,
        h,
        &model,
        6500.0,
        0.0,
        false,
        TargetPrimaries::Srgb,
    )
    .expect("apply_scene_linear_chain_f32 default-model");
    assert!(out[0] > 0.0 && out[0] < 1.0, "R out of [0,1]: {}", out[0]);
    assert!(
        (out[0] - out[1]).abs() < 1e-4,
        "R != G: {} vs {}",
        out[0],
        out[1]
    );
    assert!(
        (out[1] - out[2]).abs() < 1e-4,
        "G != B: {} vs {}",
        out[1],
        out[2]
    );
    assert!((out[3] - 1.0).abs() < 1e-6, "alpha must be 1.0: {}", out[3]);
}

/// Length mismatch surfaces as a Pipeline error, not a panic.
#[test]
fn apply_scene_linear_chain_f32_rejects_size_mismatch() {
    let model = AdjustmentModel::default();
    let bogus_input = vec![0.0f32; 10];
    let r = apply_scene_linear_chain_f32(
        &bogus_input,
        4,
        4,
        &model,
        6500.0,
        0.0,
        false,
        TargetPrimaries::Srgb,
    );
    assert!(r.is_err(), "size mismatch must error");
}

/// #1088 — NaN/Inf injected upstream must NOT reach the packed fp16
/// buffer. `skip_agx = true` + a default model makes every stage an
/// identity/short-circuit, so the injected lanes survive the chain
/// untouched and hit the pack endcap directly — which must scrub them
/// to 0.0 (`f32_to_f16_bits` preserves NaN by design, so without the
/// scrub the NaN bit pattern lands in the GPU-bound buffer verbatim).
#[test]
fn apply_scene_linear_chain_scrubs_non_finite_at_pack_endcap() {
    let w = 2u32;
    let h = 2u32;
    let vals: [[f32; 4]; 4] = [
        [f32::NAN, 0.25, 0.5, 1.0],
        [0.25, f32::INFINITY, 0.5, 1.0],
        [0.25, 0.5, f32::NEG_INFINITY, 1.0],
        [0.25, 0.25, 0.25, 1.0], // finite control pixel
    ];
    let input: Vec<u16> = vals
        .iter()
        .flat_map(|p| p.iter().map(|&v| f32_to_f16_bits(v)))
        .collect();
    // Sanity: the fp16 encode really does preserve non-finiteness on
    // the way IN (otherwise this test would be vacuous).
    assert!(f16_bits_to_f32(input[0]).is_nan(), "fp16 must carry NaN in");
    assert!(
        f16_bits_to_f32(input[5]).is_infinite(),
        "fp16 must carry Inf in"
    );

    let model = AdjustmentModel::default();
    let out = apply_scene_linear_chain(
        &input,
        w,
        h,
        &model,
        6500.0,
        0.0,
        true,
        TargetPrimaries::Srgb,
    )
    .expect("apply_scene_linear_chain NaN injection");
    for (i, &bits) in out.iter().enumerate() {
        let v = f16_bits_to_f32(bits);
        assert!(
            v.is_finite(),
            "fp16 lane {} non-finite after pack scrub: bits=0x{:04x}",
            i,
            bits
        );
    }
    // Non-finite lanes scrub to exactly 0.0…
    assert_eq!(f16_bits_to_f32(out[0]), 0.0, "NaN R lane must scrub to 0");
    assert_eq!(f16_bits_to_f32(out[5]), 0.0, "+Inf G lane must scrub to 0");
    assert_eq!(f16_bits_to_f32(out[10]), 0.0, "-Inf B lane must scrub to 0");
    // …while finite lanes pass through (default model + skip_agx is
    // identity; 0.25 is exactly representable in fp16).
    assert_eq!(f16_bits_to_f32(out[12]), 0.25, "finite lane must survive");
    assert_eq!(
        f16_bits_to_f32(out[1]),
        0.25,
        "finite lane beside NaN must survive"
    );
}

/// #1088 — f32 sibling of the NaN-injection test: same chain, packed
/// f32 endcap. Non-finite lanes scrub to 0.0, finite lanes are
/// bit-exact (no fp16 round-trip on this path).
#[test]
fn apply_scene_linear_chain_f32_scrubs_non_finite_at_pack_endcap() {
    let w = 2u32;
    let h = 2u32;
    let input: Vec<f32> = vec![
        f32::NAN,
        0.25,
        0.5,
        1.0, //
        0.25,
        f32::INFINITY,
        0.5,
        1.0, //
        0.25,
        0.5,
        f32::NEG_INFINITY,
        1.0, //
        0.25,
        0.25,
        0.25,
        1.0,
    ];
    let model = AdjustmentModel::default();
    let out = apply_scene_linear_chain_f32(
        &input,
        w,
        h,
        &model,
        6500.0,
        0.0,
        true,
        TargetPrimaries::Srgb,
    )
    .expect("apply_scene_linear_chain_f32 NaN injection");
    assert!(
        out.iter().all(|v| v.is_finite()),
        "packed f32 buffer must be NaN/Inf-free: {:?}",
        out
    );
    assert_eq!(out[0], 0.0, "NaN R lane must scrub to 0");
    assert_eq!(out[5], 0.0, "+Inf G lane must scrub to 0");
    assert_eq!(out[10], 0.0, "-Inf B lane must scrub to 0");
    assert_eq!(
        out[12].to_bits(),
        0.25f32.to_bits(),
        "finite lane must be bit-exact"
    );
    assert_eq!(
        out[1].to_bits(),
        0.25f32.to_bits(),
        "finite lane beside NaN must be bit-exact"
    );
}

/// Overflow guard: same shape as the fp16 sibling's overflow test.
#[test]
fn apply_scene_linear_chain_f32_rgba_length_overflow_errors() {
    let model = AdjustmentModel::default();
    let r = apply_scene_linear_chain_f32(
        &[],
        u32::MAX,
        u32::MAX,
        &model,
        6500.0,
        0.0,
        false,
        TargetPrimaries::Srgb,
    );
    match r {
        Err(crate::error::Error::Pipeline(msg)) => {
            assert!(
                msg.contains("overflow"),
                "expected overflow message, got: {msg}"
            );
        }
        other => panic!("expected Pipeline overflow error, got: {other:?}"),
    }
}
