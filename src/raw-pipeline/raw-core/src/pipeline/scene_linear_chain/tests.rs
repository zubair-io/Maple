//! Unit tests for `scene_linear_chain`. Split into this submodule to stay
//! under the 600-LOC file budget (#1181).
use super::*;

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
    let out = apply_scene_linear_chain(&input, w, h, &model, &ChainOptions::default())
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
        &ChainOptions {
            skip_agx: true,
            ..ChainOptions::default()
        },
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
    let r = apply_scene_linear_chain(&bogus_input, 4, 4, &model, &ChainOptions::default());
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
    let r = apply_scene_linear_chain(&[], u32::MAX, u32::MAX, &model, &ChainOptions::default());
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
        &ChainOptions {
            skip_agx: true,
            ..ChainOptions::default()
        },
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
    let out = apply_scene_linear_chain_f32(&input, w, h, &model, &ChainOptions::default())
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
    let r = apply_scene_linear_chain_f32(&bogus_input, 4, 4, &model, &ChainOptions::default());
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

    // Sharpen / nr_color zeroed (#1043): the chain runs both stages now,
    // and `AdjustmentModel::default()` carries the reference-import values
    // 40 / 25 — a spatial pass that would smear the injected NaN across
    // its neighbours and break the bit-exact finite-lane assertions below.
    // This test is about the pack endcap's scrub, so it wants the rest of
    // the chain to be identity.
    let model = AdjustmentModel {
        sharpen_amount: 0.0,
        nr_color: 0.0,
        ..AdjustmentModel::default()
    };
    let out = apply_scene_linear_chain(
        &input,
        w,
        h,
        &model,
        &ChainOptions {
            skip_agx: true,
            ..ChainOptions::default()
        },
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
    // Sharpen / nr_color zeroed — see the fp16 sibling above (#1043).
    let model = AdjustmentModel {
        sharpen_amount: 0.0,
        nr_color: 0.0,
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
    let r = apply_scene_linear_chain_f32(&[], u32::MAX, u32::MAX, &model, &ChainOptions::default());
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

// ---- Inpaint patch seam threading (#1486 M1) ----

#[test]
fn with_patches_empty_matches_plain_entry_f32() {
    let (w, h) = (4u32, 4u32);
    let n = (w * h) as usize;
    let mut input = Vec::with_capacity(n * 4);
    for i in 0..n {
        let v = 0.05 + 0.2 * (i as f32 / n as f32);
        input.extend_from_slice(&[v, v * 0.9, v * 0.8, 1.0]);
    }
    let model = AdjustmentModel::default();
    let plain =
        apply_scene_linear_chain_f32(&input, w, h, &model, &ChainOptions::default()).unwrap();
    let with = apply_scene_linear_chain_f32_with_patches(
        &input,
        w,
        h,
        &model,
        &ChainOptions::default(),
        &[],
    )
    .unwrap();
    assert_eq!(
        plain, with,
        "empty patches must be bit-identical to the plain entry"
    );
}

#[test]
fn with_patches_equals_manual_composite_then_chain_f32() {
    use crate::image::{ColorSpace, Image};
    use crate::stages::inpaint_composite;
    use crate::types::InpaintPatch;
    let (w, h) = (4u32, 4u32);
    let n = (w * h) as usize;
    let mut input = Vec::with_capacity(n * 4);
    for _ in 0..n {
        input.extend_from_slice(&[0.2, 0.2, 0.2, 1.0]);
    }
    let model = AdjustmentModel::default();
    let patch = InpaintPatch {
        width: w,
        height: h,
        origin: [0.0, 0.0],
        extent: [1.0, 1.0],
        pixels: vec![[0.6, 0.4, 0.3]; n],
        coverage: vec![1.0; n],
    };
    let via_entry = apply_scene_linear_chain_f32_with_patches(
        &input,
        w,
        h,
        &model,
        &ChainOptions::default(),
        std::slice::from_ref(&patch),
    )
    .unwrap();
    // Manual: composite into a copy of the input, then the plain chain.
    let mut img = Image {
        width: w,
        height: h,
        pixels: input.chunks_exact(4).map(|c| [c[0], c[1], c[2]]).collect(),
        space: ColorSpace::SceneLinearRec2020,
    };
    inpaint_composite::apply(&mut img, std::slice::from_ref(&patch));
    let mut composited = Vec::with_capacity(n * 4);
    for p in &img.pixels {
        composited.extend_from_slice(&[p[0], p[1], p[2], 1.0]);
    }
    let manual =
        apply_scene_linear_chain_f32(&composited, w, h, &model, &ChainOptions::default()).unwrap();
    assert_eq!(
        via_entry, manual,
        "with_patches must equal composite-then-chain"
    );
    let plain =
        apply_scene_linear_chain_f32(&input, w, h, &model, &ChainOptions::default()).unwrap();
    assert_ne!(
        via_entry, plain,
        "a full-coverage patch must change the output"
    );
}

#[test]
fn with_patches_empty_matches_plain_entry_fp16() {
    let (w, h) = (3u32, 3u32);
    let n = (w * h) as usize;
    let g = f32_to_f16_bits(0.18);
    let one = f32_to_f16_bits(1.0);
    let mut input = Vec::with_capacity(n * 4);
    for _ in 0..n {
        input.extend_from_slice(&[g, g, g, one]);
    }
    let model = AdjustmentModel::default();
    let plain = apply_scene_linear_chain(&input, w, h, &model, &ChainOptions::default()).unwrap();
    let with =
        apply_scene_linear_chain_with_patches(&input, w, h, &model, &ChainOptions::default(), &[])
            .unwrap();
    assert_eq!(
        plain, with,
        "fp16 empty patches must be bit-identical to the plain entry"
    );
}

/// The fp16 endcaps are parallel over pixels (#1089 item 8). They are pure
/// element-wise maps, so the result must be *byte*-identical regardless of
/// how rayon splits the buffer — a one-thread pool reproduces the serial
/// loop they replaced exactly, so equality against a many-thread run is
/// equality against the pre-#1089 output. This also covers the interior
/// stages, which were already parallel.
#[test]
fn chain_output_is_identical_across_thread_counts() {
    let (w, h) = (37u32, 23u32);
    let n = (w * h) as usize;
    // Varied, finite content so no stage short-circuits on a flat field and
    // both the normal and round-to-nearest arms of the packer are hit.
    let input: Vec<u16> = (0..n)
        .flat_map(|i| {
            let v = |k: usize| f32_to_f16_bits(0.05 + 0.3 * ((k % 17) as f32 / 17.0));
            [v(i), v(i * 3 + 1), v(i * 7 + 2), f32_to_f16_bits(1.0)]
        })
        .collect();
    let model = AdjustmentModel {
        nr_luminance: 40.0,
        nr_color: 40.0,
        sharpen_amount: 35.0,
        ..AdjustmentModel::default()
    };
    let run = |threads: usize| -> Vec<u16> {
        let pool = rayon::ThreadPoolBuilder::new()
            .num_threads(threads)
            .build()
            .expect("build pool");
        pool.install(|| {
            apply_scene_linear_chain(&input, w, h, &model, &ChainOptions::default()).expect("chain")
        })
    };
    assert_eq!(
        run(1),
        run(8),
        "chain output must be byte-identical across thread counts"
    );
}
