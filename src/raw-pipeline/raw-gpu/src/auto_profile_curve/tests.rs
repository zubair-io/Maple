//! Parity tests for the Auto Profile curve WGSL kernel (epic #925 / #990).
//!
//! Split out of `auto_profile_curve.rs` to keep that module under the 600-LOC
//! budget. Included via `#[path = "auto_profile_curve/tests.rs"] mod tests;` so
//! it reaches the parent's private helpers through `super::*`.
//!
//! TWO curves are gated against the REAL `apply_curve`:
//!   - IDENTITY-matrix curve (non-trivial channel curves, identity matrix, zero
//!     Oklab) → exercises `compress_input` + `eval_channel` only.
//!   - NON-identity curve (matrix + chroma_boost + offsets + band LUTs) →
//!     exercises the matrix matmul + the whole Oklab + Rec.709-luma band path.
//!
//! The identity-only test alone would be a FALSE GREEN — it never touches the
//! matrix/Oklab code (which `apply_chroma`/`identity` gate off). The non-identity
//! test is the blocking proof of that path.

use super::*;
use crate::chain::ChainRunner;
use crate::image::GpuImage;
use raw_core::view::auto_profile::apply::apply_curve;
use raw_core::view::auto_profile::curve::{ChannelCurve, ProfileCurve};

/// An RGBA test buffer spanning the curve's domain and branches:
///   - shadow / midtone / highlight greys (exercise `eval_channel` across anchors),
///   - HDR-headroom values > 1 (exercise `compress_input`'s soft-knee),
///   - saturated primaries (exercise the Oklab chroma/offset path on real chroma),
///   - a slightly-negative channel (compress_input clamps to 0),
///   - mid grey + low Y and high Y (exercise the Rec.709-luma band interp at
///     different bands).
///
/// Distinct per-channel values so the per-channel curves + cross-channel matrix
/// can't accidentally agree by symmetry.
fn branchy_rgba() -> Vec<f32> {
    vec![
        // r,    g,    b,    a
        0.05, 0.08, 0.03, 1.0, // deep shadow (low band)
        0.20, 0.35, 0.15, 0.8, // shadow-mid
        0.45, 0.50, 0.55, 1.0, // midtone grey-ish (mid band)
        0.72, 0.65, 0.80, 0.6, // highlight-mid (high band)
        0.95, 0.93, 0.97, 1.0, // near-1 (knee boundary region)
        1.40, 0.50, 0.50, 1.0, // HDR-headroom red (> 1 → compress_input bites)
        0.80, 0.10, 0.10, 1.0, // saturated red (Oklab chroma path)
        0.10, 0.80, 0.10, 0.5, // saturated green
        0.10, 0.10, 0.80, 1.0, // saturated blue
        -0.03, 0.40, 0.60, 0.9, // slightly-negative R → clamps to 0
    ]
}

/// Extract the packed `count*3` RGB from an interleaved RGBA buffer — the input
/// shape `apply_curve` (the real raw-core stage) consumes.
fn rgb_packed(rgba: &[f32]) -> Vec<f32> {
    let mut out = Vec::with_capacity(rgba.len() / 4 * 3);
    for px in rgba.chunks_exact(4) {
        out.extend_from_slice(&px[..3]);
    }
    out
}

/// Run the REAL `raw_core::view::auto_profile::apply::apply_curve` on the RGB
/// lanes of `rgba`, returning a full RGBA buffer (alpha carried through). This is
/// the ticket's reference — the actual curve function, not a reimplementation.
fn raw_core_apply_curve(rgba: &[f32], curve: &ProfileCurve) -> Vec<f32> {
    let mut rgb = rgb_packed(rgba);
    apply_curve(&mut rgb, curve);
    let mut out = Vec::with_capacity(rgba.len());
    for (i, px) in rgb.chunks_exact(3).enumerate() {
        out.extend_from_slice(&[px[0], px[1], px[2], rgba[i * 4 + 3]]);
    }
    out
}

/// A non-trivial brightness/contrast channel curve (identity matrix, zero Oklab).
/// Built by hand as a smooth gamma-ish lift so `eval_channel` interpolates real
/// (non-linear) anchors — not the identity curve, which would make the per-channel
/// stage a no-op and hide an `eval_channel` bug.
fn gamma_channel(gamma: f32) -> ChannelCurve {
    let mut c = ChannelCurve::identity();
    for a in c.anchors.iter_mut() {
        a.1 = a.0.powf(gamma);
    }
    c
}

/// An identity-MATRIX curve: real per-channel curves (different gamma per
/// channel), identity matrix, all Oklab corrections at no-op. Exercises
/// `compress_input` + `eval_channel`, and confirms BOTH flags resolve to "skip"
/// (identity matrix, apply_chroma == false).
fn identity_matrix_curve() -> ProfileCurve {
    let mut c = ProfileCurve::identity();
    c.r = gamma_channel(0.85);
    c.g = gamma_channel(0.90);
    c.b = gamma_channel(0.80);
    c
}

/// A NON-identity curve carrying per-channel curves, a non-identity cross-channel
/// matrix, a chroma boost, an (a, b) offset, an L offset, and non-zero L-band and
/// ab-band LUTs. Forces `identity == false` AND `apply_chroma == true`, so the
/// matrix matmul and the entire Oklab + band path run.
fn full_curve() -> ProfileCurve {
    let mut c = identity_matrix_curve();
    // Mild cross-channel mixing (rows sum near 1 so it stays a sane color op).
    c.matrix = [[0.95, 0.03, 0.02], [0.04, 0.92, 0.04], [0.02, 0.05, 0.93]];
    c.chroma_boost = 1.15;
    c.chroma_offset = [0.01, -0.012];
    c.lightness_offset = 0.008;
    // Opposite shadow/highlight tilts (the pattern the band LUTs exist for).
    c.lightness_band_offsets = [0.012, 0.006, 0.0, -0.006, -0.012];
    c.ab_band_offsets = [
        [0.010, -0.008],
        [0.005, -0.004],
        [0.0, 0.0],
        [-0.005, 0.006],
        [-0.010, 0.012],
    ];
    c
}

/// THE PARITY GATE (the ticket's contract): the WGSL Auto Profile curve kernel
/// matches the REAL `apply_curve` within 1e-4 on BOTH an identity-matrix curve
/// and a full non-identity curve. Pins the GPU output to the canonical CPU curve
/// function directly. The non-identity case is the blocking proof of the matrix +
/// Oklab + band path; the identity case isolates `compress_input` + `eval_channel`.
#[test]
fn wgsl_auto_profile_curve_matches_raw_core_within_1e_4() {
    let ctx = GpuContext::new_blocking().expect("gpu context");
    let input = branchy_rgba();
    let count = (input.len() / 4) as u32;

    for (label, curve) in [
        ("identity-matrix", identity_matrix_curve()),
        ("full-non-identity", full_curve()),
    ] {
        let flat = curve.to_flat();
        assert_eq!(flat.len(), PROFILE_CURVE_FLAT_LEN);
        let reference = raw_core_apply_curve(&input, &curve);

        let img = GpuImage::upload(&ctx, &input, count, 1);
        let runner = ChainRunner::new(&ctx, &img);
        let gpu = runner.run_blocking(&[&AutoProfileCurvePass {
            flat_curve: flat.into(),
        }]);

        let max_diff = reference
            .iter()
            .zip(&gpu)
            .map(|(a, b)| (a - b).abs())
            .fold(0.0_f32, f32::max);
        eprintln!("PARITY vs raw-core apply_curve [{label}]: max abs diff = {max_diff:e}");
        assert!(
            max_diff < 1e-4,
            "[{label}]: GPU vs raw-core apply_curve max abs diff {max_diff} exceeds 1e-4"
        );
    }
}

/// Pin the local CPU oracle (`apply_auto_profile_curve`) to the real `apply_curve`
/// too, so the convenience oracle this crate exports can't silently drift. Covers
/// both curves. (The GPU gate above doesn't depend on the local oracle.)
#[test]
fn local_oracle_matches_raw_core_within_1e_4() {
    let input = branchy_rgba();
    for (label, curve) in [
        ("identity-matrix", identity_matrix_curve()),
        ("full-non-identity", full_curve()),
    ] {
        let flat = curve.to_flat();
        let reference = raw_core_apply_curve(&input, &curve);
        let mut local = input.clone();
        apply_auto_profile_curve(&mut local, &flat);
        let max_diff = reference
            .iter()
            .zip(&local)
            .map(|(a, b)| (a - b).abs())
            .fold(0.0_f32, f32::max);
        assert!(
            max_diff < 1e-4,
            "[{label}]: local oracle vs raw-core apply_curve diff {max_diff} exceeds 1e-4"
        );
    }
}

/// Self-contained fallback gate: the WGSL kernel matches the local CPU oracle
/// within 1e-4 (no raw-core dep needed to run). Fast, dependency-free signal
/// alongside the raw-core gate; mirrors the vibrance precedent. Covers both curves.
#[test]
fn wgsl_auto_profile_curve_matches_cpu_oracle_within_1e_4() {
    let ctx = GpuContext::new_blocking().expect("gpu context");
    let input = branchy_rgba();
    let count = (input.len() / 4) as u32;

    for (label, curve) in [
        ("identity-matrix", identity_matrix_curve()),
        ("full-non-identity", full_curve()),
    ] {
        let flat = curve.to_flat();
        let mut cpu = input.clone();
        apply_auto_profile_curve(&mut cpu, &flat);

        let img = GpuImage::upload(&ctx, &input, count, 1);
        let runner = ChainRunner::new(&ctx, &img);
        let gpu = runner.run_blocking(&[&AutoProfileCurvePass {
            flat_curve: flat.clone().into(),
        }]);

        let max_diff = cpu
            .iter()
            .zip(&gpu)
            .map(|(a, b)| (a - b).abs())
            .fold(0.0_f32, f32::max);
        eprintln!("PARITY [{label}]: GPU vs CPU oracle max abs diff = {max_diff:e}");
        assert!(
            max_diff < 1e-4,
            "[{label}]: GPU vs CPU max abs diff {max_diff} exceeds 1e-4"
        );
    }
}

/// The flag predicates match raw-core's classification: an identity-matrix /
/// no-op-Oklab curve resolves to (identity=true, apply_chroma=false), and the
/// full curve to (identity=false, apply_chroma=true). This pins that the Pass
/// gates ITSELF correctly without a raw-core dependency — the production hot-path
/// skip the parity gate depends on.
#[test]
fn flag_predicates_classify_curves_like_raw_core() {
    let id_flat = identity_matrix_curve().to_flat();
    assert!(
        matrix_is_identity(&id_flat),
        "identity-matrix curve: matrix must be identity"
    );
    assert!(
        !should_apply_chroma(&id_flat),
        "identity-matrix curve: apply_chroma must be false (no-op Oklab)"
    );

    let full_flat = full_curve().to_flat();
    assert!(
        !matrix_is_identity(&full_flat),
        "full curve: matrix must be non-identity"
    );
    assert!(
        should_apply_chroma(&full_flat),
        "full curve: apply_chroma must be true (chroma boost + offsets + bands)"
    );
}

/// Identity ProfileCurve (identity curves, identity matrix, no-op Oklab) is a
/// near-passthrough on the GPU within [0, 1] (where `compress_input` is inert and
/// the identity curve maps each value to itself). Guards against an off-by-one in
/// the anchor indexing that would skew even a true identity curve. (Values are
/// kept ≤ 1 so the soft-knee doesn't engage; exact equality isn't asserted since
/// eval_channel's interpolation introduces sub-1e-6 noise on non-anchor inputs.)
#[test]
fn identity_profile_curve_is_near_passthrough_on_gpu() {
    let ctx = GpuContext::new_blocking().expect("gpu context");
    let input = vec![
        0.20_f32, 0.40, 0.60, 1.0, //
        0.50, 0.50, 0.50, 0.7, //
        0.90, 0.10, 0.30, 1.0,
    ];
    let count = (input.len() / 4) as u32;
    let flat = ProfileCurve::identity().to_flat();
    let img = GpuImage::upload(&ctx, &input, count, 1);
    let runner = ChainRunner::new(&ctx, &img);
    let gpu = runner.run_blocking(&[&AutoProfileCurvePass {
        flat_curve: flat.into(),
    }]);
    let max_diff = input
        .iter()
        .zip(&gpu)
        .map(|(a, b)| (a - b).abs())
        .fold(0.0_f32, f32::max);
    assert!(
        max_diff < 1e-4,
        "identity ProfileCurve should be a near-passthrough; max diff {max_diff}"
    );
}
