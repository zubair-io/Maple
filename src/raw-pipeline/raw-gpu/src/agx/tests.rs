//! AgX parity tests (epic #925 P2 / #990) — split out of `agx.rs` for the
//! 600-LOC budget. The headless GPU AgX kernel is gated DIRECTLY against the
//! real `raw_core::view::agx::apply` (the ticket's parity oracle), via the
//! test-only `raw-core` dev-dep, at `< 1e-4` per channel — including the #435
//! ratio sigmoid + outset + Oklab hue-restoration path.

use super::*;
use crate::chain::ChainRunner;
use crate::image::GpuImage;

/// A buffer that exercises every branch of the AgX transform:
///   - neutral mid-gray + other neutrals -> the row-sum-1 neutral axis,
///   - warm/saturated mids -> in-gamut after outset (gamut-compress fast-path),
///   - pure Rec.2020 primaries + a saturated red specular (20x mid-gray) ->
///     post-outset out-of-gamut -> the 24-iter Oklab bisection path,
///   - deep shadow with a non-trivial chroma + pure black -> the ratio path
///     (and the RATIO_FLOOR n<=1e-6 branch for black after the inset).
fn agx_buffer() -> Vec<f32> {
    let mut buf = vec![
        // r,     g,     b,     a        branch
        0.18, 0.18, 0.18, 1.0, // mid-gray neutral
        0.50, 0.50, 0.50, 0.7, // bright neutral
        0.01, 0.01, 0.01, 1.0, // deep neutral
        0.40, 0.30, 0.20, 0.5, // warm mid -> in-gamut
        3.60, 0.18, 0.18, 1.0, // saturated red specular (20x) -> bisection
        0.05, 0.40, 0.05, 1.0, // saturated green-ish -> bisection
        0.05, 0.05, 0.60, 1.0, // saturated blue-ish -> bisection
        0.90, 0.05, 0.85, 1.0, // saturated magenta -> bisection
        0.005, 0.001, 0.0008, 1.0, // deep shadow w/ chroma -> ratio path
        0.0, 0.0, 0.0, 1.0, // pure black -> RATIO_FLOOR branch
        8.0, 6.0, 4.0, 1.0, // HDR highlight -> shoulder + compress
    ];
    // Broaden hue/intensity coverage of the post-outset Rec.2020 soft-knee
    // (#1621): saturated scene colors across more hues, each at three
    // intensities, so the AgX grow-loop + Reinhard knee is parity-checked at
    // many points rather than a few primaries.
    let hues: [[f32; 3]; 6] = [
        [1.0, 0.45, 0.05],  // orange
        [0.85, 0.80, 0.05], // yellow
        [0.05, 0.70, 0.55], // teal
        [0.05, 0.55, 0.95], // azure
        [0.55, 0.05, 0.90], // violet
        [0.95, 0.05, 0.45], // rose
    ];
    for base in hues {
        for scale in [0.4f32, 1.2, 4.0] {
            buf.extend_from_slice(&[base[0] * scale, base[1] * scale, base[2] * scale, 1.0]);
        }
    }
    buf
}

/// Run `raw_core::view::agx::apply` on a flat interleaved RGBA f32 buffer,
/// returning a new buffer (alpha carried through). Input is
/// `SceneLinearRec2020` (the space `apply` asserts). THE reference — the Rust
/// stage itself, not a hand-copied oracle.
fn raw_core_agx(buf: &[f32], contrast: f32) -> Vec<f32> {
    use raw_core::image::{ColorSpace, Image};
    let count = buf.len() / 4;
    let mut img = Image::new(count as u32, 1, ColorSpace::SceneLinearRec2020);
    for (i, chunk) in buf.chunks_exact(4).enumerate() {
        img.pixels[i] = [chunk[0], chunk[1], chunk[2]];
    }
    raw_core::view::agx::apply(&mut img, contrast);
    let mut out = Vec::with_capacity(buf.len());
    for (i, p) in img.pixels.iter().enumerate() {
        out.extend_from_slice(&[p[0], p[1], p[2], buf[i * 4 + 3]]);
    }
    out
}

fn max_abs_diff(a: &[f32], b: &[f32]) -> f32 {
    a.iter()
        .zip(b)
        .map(|(x, y)| (x - y).abs())
        .fold(0.0_f32, f32::max)
}

/// THE PARITY GATE (the ticket's contract): the WGSL AgX kernel matches
/// `raw_core::view::agx::apply` — the actual Rust stage, via the test-only
/// raw-core dev-dep — within 1e-4, at contrast 0. Exercises the neutral axis,
/// the in-gamut gamut-compress fast-path, the out-of-gamut Oklab bisection, and
/// the deep-shadow ratio branch (including RATIO_FLOOR).
#[test]
fn wgsl_agx_matches_raw_core_stage_within_1e_4_contrast_0() {
    let ctx = GpuContext::new_blocking().expect("gpu context");
    let input = agx_buffer();
    let count = (input.len() / 4) as u32;

    let reference = raw_core_agx(&input, 0.0);

    let img = GpuImage::upload(&ctx, &input, count, 1);
    let runner = ChainRunner::new(&ctx, &img);
    let gpu = runner.run_blocking(&[&AgxPass { contrast: 0.0 }]);

    let max_diff = max_abs_diff(&reference, &gpu);
    eprintln!("PARITY vs raw-core agx::apply (contrast 0): max abs diff = {max_diff:e}");
    assert!(
        max_diff < 1e-4,
        "GPU vs raw-core agx::apply (contrast 0) max abs diff {max_diff} exceeds 1e-4"
    );
}

/// The parity gate at a NONZERO contrast — without this, the contrast-0 test is
/// a false green on the slope modulation (`slope = 1 + contrast/200`, pivoting
/// the normalized-log value around AGX_MID_NORM before the LUT sample). Both a
/// positive and a negative contrast are checked.
#[test]
fn wgsl_agx_matches_raw_core_stage_within_1e_4_nonzero_contrast() {
    let ctx = GpuContext::new_blocking().expect("gpu context");
    let input = agx_buffer();
    let count = (input.len() / 4) as u32;

    for contrast in [60.0_f32, -40.0_f32] {
        let reference = raw_core_agx(&input, contrast);

        let img = GpuImage::upload(&ctx, &input, count, 1);
        let runner = ChainRunner::new(&ctx, &img);
        let gpu = runner.run_blocking(&[&AgxPass { contrast }]);

        let max_diff = max_abs_diff(&reference, &gpu);
        eprintln!(
            "PARITY vs raw-core agx::apply (contrast {contrast}): max abs diff = {max_diff:e}"
        );
        assert!(
            max_diff < 1e-4,
            "GPU vs raw-core agx::apply (contrast {contrast}) max abs diff {max_diff} exceeds 1e-4"
        );
    }
}

/// Pin the local CPU oracle to raw-core's stage too, so the convenience oracle
/// this crate exports can't silently drift. (The GPU gate above doesn't depend
/// on the local oracle.) Checked at contrast 0 and a nonzero contrast.
#[test]
fn local_oracle_matches_raw_core_stage_within_1e_4() {
    let input = agx_buffer();
    for contrast in [0.0_f32, 60.0_f32, -40.0_f32] {
        let reference = raw_core_agx(&input, contrast);
        let mut local = input.clone();
        apply_agx(&mut local, contrast);
        let max_diff = max_abs_diff(&reference, &local);
        assert!(
            max_diff < 1e-4,
            "local oracle vs raw-core agx::apply (contrast {contrast}) diff {max_diff} exceeds 1e-4"
        );
    }
}

/// Alpha is carried through untouched by the GPU kernel (the AgX transform
/// touches only RGB). Mirrors the per-stage alpha-passthrough contract.
#[test]
fn gpu_alpha_passthrough() {
    let ctx = GpuContext::new_blocking().expect("gpu context");
    let input = agx_buffer();
    let count = (input.len() / 4) as u32;
    let img = GpuImage::upload(&ctx, &input, count, 1);
    let runner = ChainRunner::new(&ctx, &img);
    let gpu = runner.run_blocking(&[&AgxPass { contrast: 0.0 }]);
    for (i, chunk) in input.chunks_exact(4).enumerate() {
        assert_eq!(
            gpu[i * 4 + 3],
            chunk[3],
            "alpha changed at pixel {i}: {} -> {}",
            chunk[3],
            gpu[i * 4 + 3]
        );
    }
}

/// Neutral scene inputs (R=G=B) produce neutral display outputs on the GPU —
/// the load-bearing row-sum-1 structural property (raw-core's
/// `neutral_axis_preserved_across_log_domain`, mirrored on the GPU). Also pins
/// mid-gray near AGX_MID_DISPLAY (0.18).
#[test]
fn gpu_neutral_axis_preserved() {
    let ctx = GpuContext::new_blocking().expect("gpu context");
    let neutrals = [0.001_f32, 0.01, 0.05, 0.18, 0.5, 1.0, 5.0];
    let mut input = Vec::new();
    for &v in &neutrals {
        input.extend_from_slice(&[v, v, v, 1.0]);
    }
    let count = (input.len() / 4) as u32;
    let img = GpuImage::upload(&ctx, &input, count, 1);
    let runner = ChainRunner::new(&ctx, &img);
    let gpu = runner.run_blocking(&[&AgxPass { contrast: 0.0 }]);
    for (i, &v) in neutrals.iter().enumerate() {
        let p = &gpu[i * 4..i * 4 + 3];
        assert!(
            (p[0] - p[1]).abs() < 1e-4 && (p[1] - p[2]).abs() < 1e-4,
            "neutral input {v} -> non-neutral GPU output {p:?}"
        );
        for &c in p {
            assert!((0.0..=1.0).contains(&c), "out of [0,1]: {c}");
        }
    }
    // Mid-gray (index 3) lands near 0.18.
    let mid = &gpu[3 * 4..3 * 4 + 3];
    assert!(
        (mid[0] - 0.18).abs() < 1e-3,
        "mid-gray identity broken on GPU: {} != 0.18",
        mid[0]
    );
}

/// Out-of-gamut saturated red lands inside `[0, 1]^3` on the GPU and red still
/// dominates (hue preserved by the constant-L Oklab bisection, NOT rotated to
/// magenta). GPU mirror of raw-core's `saturated_highlight_reduces_in_spread`
/// / the #435 no-magenta acceptance criterion.
#[test]
fn gpu_saturated_red_lands_in_box_and_keeps_red_dominance() {
    let ctx = GpuContext::new_blocking().expect("gpu context");
    let input = vec![3.6_f32, 0.18, 0.18, 1.0]; // saturated red specular (20x mid-gray)
    let img = GpuImage::upload(&ctx, &input, 1, 1);
    let runner = ChainRunner::new(&ctx, &img);
    let gpu = runner.run_blocking(&[&AgxPass { contrast: 0.0 }]);
    for (c, &v) in gpu[..3].iter().enumerate() {
        assert!(
            (0.0..=1.0).contains(&v),
            "channel {c} out of [0, 1] after AgX: {v}"
        );
    }
    assert!(
        gpu[0] > gpu[1] && gpu[0] > gpu[2],
        "red dominance lost (hue rotated?): {:?}",
        &gpu[..3]
    );
}

/// Positive contrast steepens around mid-gray on the GPU: a bright tone goes
/// higher and a dark tone goes lower vs contrast 0. Confirms the GPU honours
/// the slope modulation in the expected direction (beyond just matching the
/// oracle numerically).
#[test]
fn gpu_positive_contrast_steepens_around_mid_gray() {
    let ctx = GpuContext::new_blocking().expect("gpu context");
    let input = vec![
        0.5_f32, 0.5, 0.5, 1.0, // bright
        0.05, 0.05, 0.05, 1.0, // dark
    ];
    let img = GpuImage::upload(&ctx, &input, 2, 1);
    let runner = ChainRunner::new(&ctx, &img);
    let base = runner.run_blocking(&[&AgxPass { contrast: 0.0 }]);
    let steep = runner.run_blocking(&[&AgxPass { contrast: 100.0 }]);
    assert!(
        steep[0] > base[0],
        "bright should go higher at +100: {} vs {}",
        steep[0],
        base[0]
    );
    assert!(
        steep[4] < base[4],
        "dark should go lower at +100: {} vs {}",
        steep[4],
        base[4]
    );
}

/// The embedded LUT this crate uploads is byte-identical to raw-core's
/// embedded copy — the parity gate's foundation (the GPU samples the exact
/// table the oracle does). raw-core embeds `view/agx_lut.bin`; so does this
/// crate. Compare the bytes directly via the dev-dep's path isn't exposed, so
/// re-read the file relative to CARGO_MANIFEST_DIR and compare to our embed.
#[test]
fn embedded_lut_matches_raw_core_file() {
    let path =
        std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../raw-core/src/view/agx_lut.bin");
    let on_disk =
        std::fs::read(&path).unwrap_or_else(|e| panic!("read {} failed: {}", path.display(), e));
    assert_eq!(
        on_disk.as_slice(),
        AGX_LUT_BYTES,
        "embedded agx_lut.bin diverges from raw-core's view/agx_lut.bin"
    );
    assert_eq!(
        AGX_LUT_SIZE,
        raw_core::view::agx::AGX_LUT_SIZE,
        "AGX_LUT_SIZE {} != raw-core AGX_LUT_SIZE {}",
        AGX_LUT_SIZE,
        raw_core::view::agx::AGX_LUT_SIZE
    );
}
