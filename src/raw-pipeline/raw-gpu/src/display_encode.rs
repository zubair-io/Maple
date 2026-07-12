//! Display-encode stage — a P2 view-transform WGSL port (epic #925 / #990).
//!
//! Mirrors the vibrance template. The GPU kernel + parity tests track
//! `raw_core::view::encode::rec2020_to_display` (#438 / #1337 / #1921): the
//! linear-Rec.2020 → linear-display-primary matrix followed by a hue-preserving
//! Oklab soft gamut compression at constant `L` (#1621 — a Reinhard soft-knee
//! that rolls chroma off below the hull rather than hard-clipping onto it).
//! Both target primaries are supported — sRGB (`target_primaries = 0`) and
//! Display P3 (`target_primaries = 1`); as of #1921 each rotates into its target
//! primaries first, then compresses against that target's hull. This is the
//! f32 → f32 display-encode step ONLY — it does NOT include the sRGB gamma
//! encode or the dither/quantize-to-u8 step (those are format-changing output
//! steps, outside the scene/display f32 chain).
//!
//! Three pieces (the per-stage template):
//! 1. [`apply_display_encode`] — the CPU oracle, **sRGB-only**: a faithful port
//!    of `rec2020_to_display(.., Srgb)`'s per-pixel math (matrix + the
//!    sRGB-specialised `compress_to_unit_cube_oklab`) over a flat RGBA f32
//!    buffer. It is a convenience oracle for the sRGB path; the P3 path is
//!    validated against the real raw-core stage directly in the parity test
//!    (piece 3), not through this helper.
//! 2. [`DisplayEncodePass`] — the GPU-resident [`Pass`], **both primaries**; its
//!    kernel concatenates the generated color matrices and selects sRGB vs P3 on
//!    the `target_primaries` uniform (it needs the Oklab + Rec.2020/sRGB/P3
//!    helpers, including the `M_P3_TO_SRGB` inverse for the P3 hull test).
//! 3. The headless parity tests (in `#[cfg(test)] mod tests`) — GPU vs
//!    `raw_core::view::encode::rec2020_to_display` (the real stage, via the
//!    test-only raw-core dev-dep) `< 1e-4`, for BOTH target primaries: sRGB
//!    (`target_primaries = 0`) and Display P3 (`target_primaries = 1`, the
//!    #1921 P3-hull path), on a buffer exercising the in-gamut byte-identity
//!    fast-path, the near-boundary soft-knee, and the out-of-gamut compression
//!    path, plus a dense (L × hue × chroma) sweep.
//!
//! ## CPU-oracle color math (sRGB-only Oklab pair)
//!
//! This section describes the [`apply_display_encode`] CPU oracle ONLY — the GPU
//! kernel gets its matrices (including the P3 pair) from the generated
//! `color_matrices.wgsl`, not from here. raw-gpu has no non-test raw-core
//! dependency, so the oracle's Oklab round-trip is a local copy — specialised to
//! the **sRGB-linear** working space (the matrix already lands the triple in
//! linear sRGB, so re-applying the inner rec2020→srgb step would double-count).
//! The matrix constants below are the same values `codegen` bakes into the WGSL
//! kernel (single-sourced via `color::matrices::M_REC2020_TO_SRGB` and
//! `color::oklab::{M1_SRGB_TO_LMS, M2_LMS_TO_LAB}` + `Matrix3::inverse()`). The
//! parity test pins the GPU output to the canonical raw-core stage directly, so
//! a transcription error here can't
//! mask a kernel bug.

use crate::chain::Pass;
use crate::context::GpuContext;
use crate::spatial::encode_simple;

/// `repr(C)` params uniform shared by the WGSL kernel (`display_encode.wgsl`).
/// `count` is the RGBA pixel count; `target_primaries` selects the matrix
/// (0 = sRGB, 1 = Display P3 per #1337); `_pad*` round the struct to 16 bytes.
#[repr(C)]
#[derive(Clone, Copy, bytemuck::Pod, bytemuck::Zeroable)]
struct Params {
    count: u32,
    target_primaries: u32, // 0 = sRGB (default), 1 = Display P3 (#1337)
    _pad1: u32,
    _pad2: u32,
}

// ── Color math (duplicated from raw_core, specialised to sRGB-linear) ──────

type Mat3 = [[f32; 3]; 3];

const M_REC2020_TO_SRGB: Mat3 = [
    [1.6605, -0.5876, -0.0728],
    [-0.1246, 1.1329, -0.0083],
    [-0.0182, -0.1006, 1.1187],
];
// Verbatim copies of `raw_core::color::oklab::{M1_SRGB_TO_LMS, M2_LMS_TO_LAB}`.
// The literals carry more digits than f32 stores (clippy `excessive_precision`),
// intentional — truncating would silently diverge from the canonical source.
#[allow(clippy::excessive_precision)]
const M1_SRGB_TO_LMS: Mat3 = [
    [0.412_221_47, 0.536_332_54, 0.051_445_99],
    [0.211_903_50, 0.680_699_55, 0.107_396_96],
    [0.088_302_46, 0.281_718_84, 0.629_978_70],
];
#[allow(clippy::excessive_precision)]
const M2_LMS_TO_LAB: Mat3 = [
    [0.210_454_26, 0.793_617_79, -0.004_072_05],
    [1.977_998_50, -2.428_592_21, 0.450_593_71],
    [0.025_904_04, 0.782_771_77, -0.808_675_77],
];

#[inline]
fn mul3(m: &Mat3, v: [f32; 3]) -> [f32; 3] {
    [
        m[0][0] * v[0] + m[0][1] * v[1] + m[0][2] * v[2],
        m[1][0] * v[0] + m[1][1] * v[1] + m[1][2] * v[2],
        m[2][0] * v[0] + m[2][1] * v[1] + m[2][2] * v[2],
    ]
}

/// 3×3 inverse (cofactor / determinant). Matches `raw_core::math::Matrix3::inverse`.
fn inverse3(m: &Mat3) -> Mat3 {
    let det = m[0][0] * (m[1][1] * m[2][2] - m[1][2] * m[2][1])
        - m[0][1] * (m[1][0] * m[2][2] - m[1][2] * m[2][0])
        + m[0][2] * (m[1][0] * m[2][1] - m[1][1] * m[2][0]);
    let inv_det = 1.0 / det;
    [
        [
            (m[1][1] * m[2][2] - m[1][2] * m[2][1]) * inv_det,
            -(m[0][1] * m[2][2] - m[0][2] * m[2][1]) * inv_det,
            (m[0][1] * m[1][2] - m[0][2] * m[1][1]) * inv_det,
        ],
        [
            -(m[1][0] * m[2][2] - m[1][2] * m[2][0]) * inv_det,
            (m[0][0] * m[2][2] - m[0][2] * m[2][0]) * inv_det,
            -(m[0][0] * m[1][2] - m[0][2] * m[1][0]) * inv_det,
        ],
        [
            (m[1][0] * m[2][1] - m[1][1] * m[2][0]) * inv_det,
            -(m[0][0] * m[2][1] - m[0][1] * m[2][0]) * inv_det,
            (m[0][0] * m[1][1] - m[0][1] * m[1][0]) * inv_det,
        ],
    ]
}

/// Linear sRGB D65 → Oklab (NO inner rec2020 step). Mirrors
/// `raw_core::color::oklab::srgb_linear_to_oklab`.
fn srgb_linear_to_oklab(rgb: [f32; 3]) -> [f32; 3] {
    let lms = mul3(&M1_SRGB_TO_LMS, rgb);
    let lms_cube = [lms[0].cbrt(), lms[1].cbrt(), lms[2].cbrt()];
    mul3(&M2_LMS_TO_LAB, lms_cube)
}

/// Oklab → linear sRGB D65. Mirrors `raw_core::color::oklab::oklab_to_srgb_linear`.
fn oklab_to_srgb_linear(lab: [f32; 3]) -> [f32; 3] {
    let m2_inv = inverse3(&M2_LMS_TO_LAB);
    let m1_inv = inverse3(&M1_SRGB_TO_LMS);
    let lms_cube = mul3(&m2_inv, lab);
    let lms = [
        lms_cube[0] * lms_cube[0] * lms_cube[0],
        lms_cube[1] * lms_cube[1] * lms_cube[1],
        lms_cube[2] * lms_cube[2] * lms_cube[2],
    ];
    mul3(&m1_inv, lms)
}

/// In-gamut predicate with the fp-edge epsilon (EPS_HI = 1 + 1e-5,
/// EPS_LO = -1e-5). Mirrors `raw_core::color::oklab_gamut::in_unit_box`.
#[inline]
fn in_unit_box(rgb: [f32; 3]) -> bool {
    const EPS_HI: f32 = 1.0 + 1e-5;
    const EPS_LO: f32 = -1e-5;
    rgb[0] >= EPS_LO
        && rgb[0] <= EPS_HI
        && rgb[1] >= EPS_LO
        && rgb[1] <= EPS_HI
        && rgb[2] >= EPS_LO
        && rgb[2] <= EPS_HI
}

/// Soft, hue-preserving gamut compression toward `[0, 1]^3` via Oklab `(a, b)`
/// scaling at constant `L`, specialised to the sRGB-linear working space.
/// Mirrors `raw_core::color::oklab_gamut::compress_to_unit_cube_oklab` (#1621):
/// chroma below `THRESHOLD * hull` passes through untouched; chroma beyond is
/// rolled off with a Reinhard soft-knee that stays strictly increasing and
/// bounded by the hull (no clip-to-hull plateau).
fn compress_to_unit_cube(rgb: [f32; 3]) -> [f32; 3] {
    const CHROMA_FLOOR: f32 = 1e-5;
    const COMPRESS_THRESHOLD: f32 = 0.8;

    let lab = srgb_linear_to_oklab(rgb);
    let (l, a, b) = (lab[0], lab[1], lab[2]);
    let c_in = (a * a + b * b).sqrt();
    if c_in <= CHROMA_FLOOR {
        return [
            rgb[0].clamp(0.0, 1.0),
            rgb[1].clamp(0.0, 1.0),
            rgb[2].clamp(0.0, 1.0),
        ];
    }
    let scale_chroma = |s: f32| oklab_to_srgb_linear([l, a * s, b * s]);
    if in_unit_box(scale_chroma(1.0 / COMPRESS_THRESHOLD)) {
        return rgb;
    }
    let s_hull = hull_scale(&scale_chroma);
    let hull = c_in * s_hull;
    if !hull.is_finite() || hull <= CHROMA_FLOOR {
        let out = scale_chroma(s_hull.max(0.0));
        return [
            out[0].clamp(0.0, 1.0),
            out[1].clamp(0.0, 1.0),
            out[2].clamp(0.0, 1.0),
        ];
    }
    let knee = COMPRESS_THRESHOLD * hull;
    let c_out = if c_in <= knee {
        c_in
    } else {
        let x = (c_in - knee) / (hull - knee);
        knee + (hull - knee) * (x / (1.0 + x))
    };
    let out = scale_chroma(c_out / c_in);
    [
        out[0].clamp(0.0, 1.0),
        out[1].clamp(0.0, 1.0),
        out[2].clamp(0.0, 1.0),
    ]
}

/// Largest in-gamut chroma scale (bracket + 24-iter bisection). Mirrors
/// `raw_core::color::oklab_gamut::hull_scale`.
fn hull_scale<S: Fn(f32) -> [f32; 3]>(scaled: &S) -> f32 {
    let in_at = |s: f32| in_unit_box(scaled(s));
    let (mut lo, mut hi) = if in_at(1.0) {
        let mut s = 1.0f32;
        let mut steps = 0;
        while in_at(s) && steps < 16 {
            s *= 2.0;
            steps += 1;
        }
        if in_at(s) {
            return s;
        }
        (s * 0.5, s)
    } else {
        (0.0, 1.0)
    };
    for _ in 0..24 {
        let mid = 0.5 * (lo + hi);
        if in_at(mid) {
            lo = mid;
        } else {
            hi = mid;
        }
    }
    lo
}

/// Rec.2020 → sRGB display encode with hue-preserving gamut compression on an
/// interleaved RGBA f32 buffer (alpha untouched). This is the CPU oracle — a
/// faithful port of `raw_core::view::encode::rec2020_to_srgb`: matrix multiply
/// then `compress_to_unit_cube`. f32 → f32; no gamma, no quantize.
pub fn apply_display_encode(buf: &mut [f32]) {
    for px in buf.chunks_exact_mut(4) {
        let srgb = mul3(&M_REC2020_TO_SRGB, [px[0], px[1], px[2]]);
        let out = compress_to_unit_cube(srgb);
        px[0] = out[0];
        px[1] = out[1];
        px[2] = out[2];
        // px[3] (alpha) untouched
    }
}

/// A GPU-resident display-encode stage (Rec.2020 → display-primary + gamut
/// compress). Carries the `target_primaries` selector for #1337 — defaults to
/// `0` (sRGB) so the pre-#1337 output is preserved bit-exactly when the chain
/// does not set the field. The device, pipeline, and ping-pong buffers come
/// from the [`GpuContext`] / [`ChainRunner`].
pub struct DisplayEncodePass {
    /// `0` = sRGB primaries (default, legacy-compatible).
    /// `1` = Display P3 primaries (SMPTE RP 431-2, D65) — ticket #1337.
    pub target_primaries: u32,
}

impl Pass for DisplayEncodePass {
    fn encode(
        &self,
        ctx: &GpuContext,
        encoder: &mut wgpu::CommandEncoder,
        src: &wgpu::Buffer,
        dst: &wgpu::Buffer,
        dims: (u32, u32),
    ) {
        let (width, height) = dims;
        let pixel_count = width * height;

        let params = Params {
            count: pixel_count,
            target_primaries: self.target_primaries,
            _pad1: 0,
            _pad2: 0,
        };
        // Pooled per-pixel dispatch (P4b-core C3): params @0, src @1, dst @2.
        encode_simple(
            ctx,
            encoder,
            ctx.display_encode_pipeline(),
            bytemuck::bytes_of(&params),
            &[src, dst],
            pixel_count,
            "display-encode",
        );
    }
}

#[cfg(all(test, not(target_arch = "wasm32")))]
mod tests {
    use super::*;
    use crate::chain::ChainRunner;
    use crate::image::GpuImage;

    /// A buffer that exercises EVERY branch of the soft compressor:
    ///   - in-gamut neutrals/mids → the byte-identity fast-path (most pixels),
    ///   - near-boundary in-gamut saturated colors → the knee probe + grow-loop
    ///     hull search + Reinhard soft-knee (the #1621 paths most likely to
    ///     diverge between the WGSL grow-loop and the Rust one),
    ///   - saturated wide-gamut primaries (pure Rec.2020 R/G/B + magenta) whose
    ///     post-matrix sRGB triple leaves `[0, 1]^3` → out-of-gamut bisection,
    ///   - HDR-headroom (> 1) → out-of-gamut overshoot.
    ///
    /// The hand-picked corner cases are followed by a dense sweep over
    /// (lightness × hue × chroma) generated in Oklab, so the GPU↔CPU parity
    /// gate covers the whole color volume rather than a handful of points.
    fn encode_buffer() -> Vec<f32> {
        let mut buf = vec![
            // r,    g,    b,    a       branch
            0.18, 0.18, 0.18, 1.0, // neutral mid-gray → in-gamut fast-path
            0.40, 0.30, 0.20, 0.7, // warm mid → in-gamut
            0.05, 0.05, 0.05, 1.0, // deep neutral → in-gamut
            0.70, 0.12, 0.12, 1.0, // near-boundary red → knee/grow path
            0.12, 0.55, 0.18, 1.0, // near-boundary green → knee/grow path
            0.20, 0.20, 0.62, 0.9, // near-boundary blue → knee/grow path
            1.00, 0.00, 0.00, 1.0, // pure Rec.2020 red → out-of-gamut (G,B neg)
            0.00, 1.00, 0.00, 1.0, // pure Rec.2020 green → out-of-gamut
            0.00, 0.00, 1.00, 0.5, // pure Rec.2020 blue → out-of-gamut
            0.90, 0.05, 0.85, 1.0, // saturated magenta → out-of-gamut
            2.00, 1.50, 0.50, 1.0, // HDR headroom (> 1) → out-of-gamut overshoot
        ];
        // Dense (L × hue × chroma) sweep in Oklab → Rec.2020, spanning in-gamut
        // core, the compression knee, and well out of gamut.
        let mut hue_deg = 0.0f32;
        while hue_deg < 360.0 {
            let h = hue_deg.to_radians();
            let (sin_h, cos_h) = h.sin_cos();
            for li in 0..3 {
                let l = 0.30 + 0.20 * li as f32; // 0.30, 0.50, 0.70
                for ci in 0..5 {
                    let c = 0.04 + 0.06 * ci as f32; // 0.04 .. 0.28
                    let rgb = raw_core::color::oklab::oklab_to_rec2020([l, c * cos_h, c * sin_h]);
                    buf.extend_from_slice(&[rgb[0], rgb[1], rgb[2], 1.0]);
                }
            }
            hue_deg += 30.0;
        }
        buf
    }

    /// Run `raw_core::view::encode::rec2020_to_display` on a flat interleaved
    /// RGBA f32 buffer for the given target primaries, returning a new buffer
    /// (alpha carried through). The input is `DisplayLinearRec2020` (the space
    /// the stage asserts). This is the ticket's actual reference — the Rust
    /// stage itself.
    fn raw_core_display_encode_target(
        buf: &[f32],
        target: raw_core::view::encode::TargetPrimaries,
    ) -> Vec<f32> {
        use raw_core::image::{ColorSpace, Image};
        let count = buf.len() / 4;
        let mut img = Image::new(count as u32, 1, ColorSpace::DisplayLinearRec2020);
        for (i, chunk) in buf.chunks_exact(4).enumerate() {
            img.pixels[i] = [chunk[0], chunk[1], chunk[2]];
        }
        raw_core::view::encode::rec2020_to_display(&mut img, target);
        let mut out = Vec::with_capacity(buf.len());
        for (i, p) in img.pixels.iter().enumerate() {
            out.extend_from_slice(&[p[0], p[1], p[2], buf[i * 4 + 3]]);
        }
        out
    }

    /// sRGB convenience wrapper — the pre-#1921 reference used by the sRGB gates.
    fn raw_core_display_encode(buf: &[f32]) -> Vec<f32> {
        raw_core_display_encode_target(buf, raw_core::view::encode::TargetPrimaries::Srgb)
    }

    /// THE PARITY GATE (the ticket's contract): the WGSL display-encode kernel
    /// matches `raw_core::view::encode::rec2020_to_srgb` — the actual Rust stage,
    /// via the test-only raw-core dev-dep — within 1e-4, on a buffer exercising
    /// both the in-gamut byte-identity fast-path and the out-of-gamut 24-iter
    /// bisection path.
    #[test]
    fn wgsl_display_encode_matches_raw_core_stage_within_1e_4() {
        let ctx = GpuContext::new_blocking().expect("gpu context");
        let input = encode_buffer();
        let count = (input.len() / 4) as u32;

        let reference = raw_core_display_encode(&input);

        let img = GpuImage::upload(&ctx, &input, count, 1);
        let runner = ChainRunner::new(&ctx, &img);
        let gpu = runner.run_blocking(&[&DisplayEncodePass {
            target_primaries: 0,
        }]);

        let max_diff = reference
            .iter()
            .zip(&gpu)
            .map(|(a, b)| (a - b).abs())
            .fold(0.0_f32, f32::max);
        eprintln!("PARITY vs raw-core rec2020_to_srgb: max abs diff = {max_diff:e}");
        assert!(
            max_diff < 1e-4,
            "GPU vs raw-core rec2020_to_srgb max abs diff {max_diff} exceeds 1e-4"
        );
    }

    /// P3 PARITY GATE (#1921): the WGSL display-encode kernel with
    /// `target_primaries = 1` matches `raw_core::view::encode::rec2020_to_display`
    /// with `TargetPrimaries::P3` — the corrected P3 path that rotates Rec.2020 →
    /// linear P3 first, then gamut-compresses against the P3 hull. The buffer
    /// includes pure Rec.2020 primaries (out of even the P3 gamut) plus the dense
    /// L × hue × chroma sweep, so both the P3-hull bisection and the byte-identity
    /// fast-path are exercised. Same 1e-4 tolerance as the sRGB gate (FMA-noise
    /// floor).
    #[test]
    fn wgsl_display_encode_p3_matches_raw_core_stage_within_1e_4() {
        let ctx = GpuContext::new_blocking().expect("gpu context");
        let input = encode_buffer();
        let count = (input.len() / 4) as u32;

        let reference =
            raw_core_display_encode_target(&input, raw_core::view::encode::TargetPrimaries::P3);

        let img = GpuImage::upload(&ctx, &input, count, 1);
        let runner = ChainRunner::new(&ctx, &img);
        let gpu = runner.run_blocking(&[&DisplayEncodePass {
            target_primaries: 1,
        }]);

        let max_diff = reference
            .iter()
            .zip(&gpu)
            .map(|(a, b)| (a - b).abs())
            .fold(0.0_f32, f32::max);
        eprintln!("PARITY vs raw-core rec2020_to_display(P3): max abs diff = {max_diff:e}");
        assert!(
            max_diff < 1e-4,
            "GPU vs raw-core rec2020_to_display(P3) max abs diff {max_diff} exceeds 1e-4"
        );
    }

    /// Pin the local CPU oracle to raw-core's stage too, so the convenience
    /// oracle this crate exports can't silently drift. (The GPU gate above
    /// doesn't depend on the local oracle.)
    #[test]
    fn local_oracle_matches_raw_core_stage_within_1e_4() {
        let input = encode_buffer();
        let reference = raw_core_display_encode(&input);
        let mut local = input.clone();
        apply_display_encode(&mut local);
        let max_diff = reference
            .iter()
            .zip(&local)
            .map(|(a, b)| (a - b).abs())
            .fold(0.0_f32, f32::max);
        assert!(
            max_diff < 1e-4,
            "local oracle vs raw-core rec2020_to_srgb diff {max_diff} exceeds 1e-4"
        );
    }

    /// In-gamut input takes the byte-identity fast-path — asserted on the CPU
    /// ORACLE, where it has real teeth. For in-gamut input the result must equal
    /// the pure matrix multiply BIT-FOR-BIT (no Oklab round-trip drift); a broken
    /// fast-path would instead return `oklab_to_srgb_linear(srgb_linear_to_oklab(m))`,
    /// which differs in the low bits. This mirrors raw-core's
    /// `in_gamut_input_passes_through_byte_identical` contract.
    ///
    /// Why CPU and not GPU: the GPU's `dot()` matmul uses FMA, so its output is
    /// ~1 ULP off the CPU's sequential mul-add — a legitimate, expected
    /// difference that is at/below the Oklab round-trip noise floor. So NO GPU
    /// bit-identity (or even tight-tolerance) test can separate "fast-path" from
    /// "round-trip" for in-gamut input; the GPU side relies on the parity gate
    /// for correctness instead. (CPU↔GPU bit-identity is never valid across the
    /// FMA boundary.) The CPU oracle is FMA-free and reproducible, so the
    /// fast-path branch is guarded here with teeth.
    #[test]
    fn in_gamut_input_takes_byte_identity_fast_path_on_cpu_oracle() {
        // Neutrals/mids whose post-matrix sRGB triple is strictly in [0, 1]^3.
        let inputs = [
            [0.18_f32, 0.18, 0.18],
            [0.5, 0.5, 0.5],
            [0.4, 0.3, 0.2],
            [0.05, 0.05, 0.05],
        ];
        for input in inputs {
            let expected = mul3(&M_REC2020_TO_SRGB, input);
            // Pre-condition: this triple must actually be in-gamut post-matrix,
            // else we'd be asserting on the bisection branch.
            assert!(
                in_unit_box(expected),
                "test setup: input {input:?} is NOT in-gamut post-matrix ({expected:?})"
            );
            let mut buf = vec![input[0], input[1], input[2], 1.0];
            apply_display_encode(&mut buf);
            for c in 0..3 {
                assert_eq!(
                    buf[c].to_bits(),
                    expected[c].to_bits(),
                    "byte-identity fast-path broken on channel {c} for input {input:?}: \
                     got {} expected {}",
                    buf[c],
                    expected[c]
                );
            }
            assert_eq!(buf[3], 1.0, "alpha must pass through unchanged");
        }
    }

    /// Out-of-gamut saturated wide-gamut red lands inside `[0, 1]^3` on the GPU
    /// (the bisection path fires and clamps), and red still dominates (hue is
    /// preserved by the constant-L bisection — NOT rotated toward magenta as a
    /// per-channel clip would do). GPU mirror of raw-core's
    /// `saturated_rec2020_red_preserves_hue` contract.
    #[test]
    fn out_of_gamut_red_lands_in_box_and_keeps_red_dominance_on_gpu() {
        let ctx = GpuContext::new_blocking().expect("gpu context");
        let input = vec![1.0_f32, 0.0, 0.0, 1.0]; // pure Rec.2020 red
        let img = GpuImage::upload(&ctx, &input, 1, 1);
        let runner = ChainRunner::new(&ctx, &img);
        let gpu = runner.run_blocking(&[&DisplayEncodePass {
            target_primaries: 0,
        }]);
        for (c, &v) in gpu[..3].iter().enumerate() {
            assert!(
                (0.0..=1.0).contains(&v),
                "channel {c} out of [0, 1] after compression: {v}"
            );
        }
        assert!(
            gpu[0] > gpu[1] && gpu[0] > gpu[2],
            "red dominance lost (hue rotated?): {:?}",
            &gpu[..3]
        );
    }
}
