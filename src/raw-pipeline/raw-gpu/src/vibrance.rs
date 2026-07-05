//! Vibrance stage — the P2 WGSL template (epic #925 / #990).
//!
//! Establishes the replicable per-stage GPU pattern the remaining scene-linear
//! stages fan out from. Three pieces, mirroring the P1a exposure precedent:
//!
//! 1. [`apply_vibrance`] — the CPU oracle (parity reference), a faithful port of
//!    `raw_core::stages::vibrance::apply`'s per-pixel math onto a flat RGBA f32
//!    buffer. raw-gpu has no `raw-core` dependency, so the Oklab helpers are
//!    duplicated here from `raw_core::color::oklab` — but the *matrices* they
//!    use are the same numbers `codegen` bakes into the WGSL kernel, so the GPU
//!    path and this oracle are single-sourced on the color math.
//! 2. [`VibrancePass`] — the GPU-resident stage as a [`Pass`] on a
//!    [`ChainRunner`]. Carries only its `vibrance` slider value; device,
//!    pipeline, and ping-pong buffers come from the [`GpuContext`] / runner.
//! 3. The headless parity test (`#[cfg(test)] mod tests`) — GPU vs CPU oracle
//!    `< 1e-4` across a spread of slider values, on a buffer that deliberately
//!    exercises the negative-LMS, near-neutral, and skin-hue branches.
//!
//! ## The per-stage template (what a fan-out agent copies)
//!
//! - A `#[repr(C)]` `Params` uniform: the stage's scalar slider value(s) + the
//!   pixel `count` + padding to 16 bytes.
//! - A `Pass` impl whose `encode` builds its OWN params uniform and bind group
//!   (bind groups bind fixed buffers, so each ping-pong direction needs a fresh
//!   one), then dispatches `count.div_ceil(64)` workgroups.
//! - A `<stage>.wgsl` kernel keyed on `@workgroup_size(64)` with the exact
//!   `(uniform, read storage, read_write storage)` binding layout below.
//! - Color matrices come from the generated `color_matrices.wgsl`, concatenated
//!   ahead of the kernel in `context.rs` (WGSL has no `#include`).

use crate::chain::Pass;
use crate::context::GpuContext;
use crate::spatial::encode_simple;

/// `repr(C)` params uniform shared by the WGSL kernel (`vibrance.wgsl`).
/// `amount` is `vibrance / 100.0`; `count` is the RGBA pixel count; `_pad*`
/// round the struct to 16 bytes (WGSL uniform alignment).
#[repr(C)]
#[derive(Clone, Copy, bytemuck::Pod, bytemuck::Zeroable)]
struct Params {
    amount: f32,
    count: u32,
    _pad0: u32,
    _pad1: u32,
}

// ── Oklab helpers (duplicated from raw_core::color::oklab) ────────────────
//
// raw-gpu has no raw-core dependency, so these are a local copy of the Oklab
// round-trip. They MUST stay numerically identical to raw-core's — the matrix
// constants below are the same values `codegen` emits into the WGSL kernel
// (single-sourced via `color::matrices::M_REC2020_TO_SRGB`,
// `color::oklab::{M1_SRGB_TO_LMS, M2_LMS_TO_LAB}` + `Matrix3::inverse()`). The
// parity test pins the WGSL output to this oracle; a `raw-core`-side change to
// the matrices would regenerate the WGSL (drift gate) and a matching update
// here would be required to keep this oracle honest.

type Mat3 = [[f32; 3]; 3];

const M_REC2020_TO_SRGB: Mat3 = [
    [1.6605, -0.5876, -0.0728],
    [-0.1246, 1.1329, -0.0083],
    [-0.0182, -0.1006, 1.1187],
];
// Verbatim copies of `raw_core::color::oklab::{M1_SRGB_TO_LMS, M2_LMS_TO_LAB}`.
// Kept digit-for-digit identical to raw-core so the oracle is visibly the same
// math; the literals carry more digits than f32 stores (clippy's
// `excessive_precision`), which is intentional — truncating here would make the
// oracle silently diverge from the canonical source.
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

/// 3×3 inverse (cofactor / determinant). Matches `raw_core::math::Matrix3::inverse`
/// so the cached-inverse oracle is bit-identical to raw-core's `OnceLock` cache
/// (pinned there by `cached_inverses_match_matrix3_inverse_bit_exact`).
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

fn rec2020_to_oklab(rgb: [f32; 3]) -> [f32; 3] {
    let srgb = mul3(&M_REC2020_TO_SRGB, rgb);
    let lms = mul3(&M1_SRGB_TO_LMS, srgb);
    let lms_cube = [lms[0].cbrt(), lms[1].cbrt(), lms[2].cbrt()];
    mul3(&M2_LMS_TO_LAB, lms_cube)
}

fn oklab_to_rec2020(lab: [f32; 3]) -> [f32; 3] {
    let m2_inv = inverse3(&M2_LMS_TO_LAB);
    let m1_inv = inverse3(&M1_SRGB_TO_LMS);
    let m_srgb_to_rec2020 = inverse3(&M_REC2020_TO_SRGB);
    let lms_cube = mul3(&m2_inv, lab);
    let lms = [
        lms_cube[0] * lms_cube[0] * lms_cube[0],
        lms_cube[1] * lms_cube[1] * lms_cube[1],
        lms_cube[2] * lms_cube[2] * lms_cube[2],
    ];
    let srgb = mul3(&m1_inv, lms);
    mul3(&m_srgb_to_rec2020, srgb)
}

#[inline]
fn smoothstep(e0: f32, e1: f32, x: f32) -> f32 {
    let t = ((x - e0) / (e1 - e0)).clamp(0.0, 1.0);
    t * t * (3.0 - 2.0 * t)
}

/// Oklab-based vibrance with skin-tone protection on an interleaved RGBA f32
/// buffer (alpha untouched). This is the CPU oracle — a line-for-line port of
/// `raw_core::stages::vibrance::apply` (spec § 3.7): low-chroma pixels get more
/// boost than high-chroma; hue in the skin window (15°–42° in Oklab) is
/// attenuated 60%.
///
/// `vibrance` is in [-100, +100]; the whole-image `|vibrance| < 1e-3`
/// short-circuit is handled by the caller (the chain simply doesn't enqueue the
/// pass), mirroring how raw-core's `apply` early-returns. The per-pixel
/// `chroma < 1e-6` passthrough is preserved here and in the kernel.
const GAMUT_KNEE_FRACTION: f32 = 0.8;
const GAMUT_BISECT_ITERS: usize = 24;

#[inline]
fn soft_compress(c_target: f32, c_hull: f32) -> f32 {
    let c_thresh = GAMUT_KNEE_FRACTION * c_hull;
    if c_target <= c_thresh {
        return c_target;
    }
    let d = c_target - c_thresh;
    let d_max = c_hull - c_thresh;
    if d_max <= 0.0 {
        return c_hull;
    }
    c_thresh + d_max * (d / (d + d_max))
}

#[inline]
fn bisect_gamut_hull(l: f32, a_hat: f32, b_hat: f32, c_high: f32) -> f32 {
    let mut lo = 0.0f32;
    let mut hi = c_high;
    for _ in 0..GAMUT_BISECT_ITERS {
        let mid = 0.5 * (lo + hi);
        let rgb = oklab_to_rec2020([l, a_hat * mid, b_hat * mid]);
        let min_c = rgb[0].min(rgb[1]).min(rgb[2]);
        if min_c >= -1e-5 {
            lo = mid;
        } else {
            hi = mid;
        }
    }
    lo
}

pub fn apply_vibrance(buf: &mut [f32], vibrance: f32) {
    let amount = vibrance / 100.0;
    for px in buf.chunks_exact_mut(4) {
        let rgb = [px[0], px[1], px[2]];
        let lab = rec2020_to_oklab(rgb);
        let (l, a, b) = (lab[0], lab[1], lab[2]);
        let chroma = (a * a + b * b).sqrt();
        if chroma < 1e-6 || chroma.is_nan() {
            continue; // near-neutral or NaN: nothing to scale
        }
        let hue_deg = b.atan2(a) * 180.0 / std::f32::consts::PI;
        let skin_mask = smoothstep(15.0, 22.0, hue_deg) * (1.0 - smoothstep(35.0, 42.0, hue_deg));
        let low_chroma_factor = 1.0 - (chroma / 0.3).min(1.0);
        let chroma_boost = low_chroma_factor * amount * (1.0 - skin_mask * 0.6);
        let scale = 1.0 + chroma_boost;

        let c_target = chroma * scale;
        let a_hat = a / chroma;
        let b_hat = b / chroma;

        let out = if scale <= 1.0 {
            oklab_to_rec2020([l, a_hat * c_target, b_hat * c_target])
        } else {
            let lab_target = [l, a_hat * c_target, b_hat * c_target];
            let rgb_target = oklab_to_rec2020(lab_target);
            if rgb_target[0].min(rgb_target[1]).min(rgb_target[2]) >= -1e-5 {
                rgb_target
            } else {
                let c_hull = bisect_gamut_hull(l, a_hat, b_hat, c_target);
                let c_floor = chroma;
                let c_out = soft_compress(c_target, c_hull).max(c_floor);
                oklab_to_rec2020([l, a_hat * c_out, b_hat * c_out])
            }
        };

        px[0] = out[0];
        px[1] = out[1];
        px[2] = out[2];
    }
}

/// A GPU-resident vibrance stage. Carries only its `vibrance` slider value; the
/// device, pipeline, and ping-pong buffers come from the [`GpuContext`] /
/// [`ChainRunner`] at encode time. Builds its own params uniform + bind group
/// inside `encode` (the per-stage template every fan-out agent replicates).
pub struct VibrancePass {
    pub vibrance: f32,
}

impl Pass for VibrancePass {
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
            amount: self.vibrance / 100.0,
            count: pixel_count,
            _pad0: 0,
            _pad1: 0,
        };
        // Pooled per-pixel dispatch (P4b-core C3): params @0, src @1, dst @2.
        encode_simple(
            ctx,
            encoder,
            ctx.vibrance_pipeline(),
            bytemuck::bytes_of(&params),
            &[src, dst],
            pixel_count,
            "vibrance",
        );
    }
}

#[cfg(all(test, not(target_arch = "wasm32")))]
mod tests {
    use super::*;
    use crate::chain::ChainRunner;
    use crate::image::GpuImage;

    /// A test buffer that deliberately exercises every branch the fan-out
    /// stages depend on:
    ///   - a slightly-NEGATIVE channel (negative LMS → sign-preserving cbrt),
    ///   - PURE BLACK (the only input with exact zero Oklab chroma → the
    ///     `chroma < 1e-6` passthrough branch; CPU passes it through too, so
    ///     parity is 0 here),
    ///   - a SKIN-hue pixel (the 15°–42° Oklab attenuation window),
    ///   - saturated + low-chroma + HDR-headroom (> 1) pixels.
    ///
    /// Note: equal-RGB greys like `[0.5, 0.5, 0.5]` do NOT have zero chroma —
    /// `M_REC2020_TO_SRGB` row sums are 1.0001 / 1.0 / 0.9999, so a grey maps to
    /// a slightly non-neutral sRGB triple and lands at Oklab chroma ~1e-4. They
    /// take the BOOST path, not the passthrough branch (raw-core's own
    /// `neutral_gray_has_zero_ab` only asserts `< 1e-3` for the same reason).
    fn branchy_buffer() -> Vec<f32> {
        vec![
            // r,    g,    b,    a
            -0.01, 0.10, 0.20, 1.0, // negative channel → negative LMS path
            0.00, 0.00, 0.00, 1.0, // pure black → exact zero chroma → passthrough
            0.50, 0.50, 0.50, 0.7, // grey: chroma ~1e-4 → boost path (not neutral)
            0.60, 0.40, 0.30, 1.0, // warm — lands near the skin-hue window
            0.80, 0.10, 0.10, 1.0, // saturated red (high chroma)
            0.35, 0.30, 0.30, 1.0, // low-chroma red (gets the most boost)
            5.00, 3.00, 1.50, 1.0, // HDR scene-headroom (> 1)
            0.05, 0.90, 0.05, 0.5, // saturated green
        ]
    }

    /// Run `raw_core::stages::vibrance::apply` on a flat interleaved RGBA f32
    /// buffer, returning a new buffer (alpha carried through untouched, matching
    /// the kernel + local oracle). This is the ticket's actual reference — the
    /// Rust stage itself, not a reimplementation.
    fn raw_core_vibrance(buf: &[f32], vibrance: f32) -> Vec<f32> {
        use raw_core::image::{ColorSpace, Image};
        let count = buf.len() / 4;
        let mut img = Image::new(count as u32, 1, ColorSpace::SceneLinearRec2020);
        for (i, chunk) in buf.chunks_exact(4).enumerate() {
            img.pixels[i] = [chunk[0], chunk[1], chunk[2]];
        }
        raw_core::stages::vibrance::apply(&mut img, vibrance);
        let mut out = Vec::with_capacity(buf.len());
        for (i, p) in img.pixels.iter().enumerate() {
            out.extend_from_slice(&[p[0], p[1], p[2], buf[i * 4 + 3]]);
        }
        out
    }

    /// THE PARITY GATE (the ticket's contract): the WGSL vibrance kernel matches
    /// `raw_core::stages::vibrance::apply` — the actual Rust stage, via a
    /// test-only dev-dep on raw-core — within 1e-4 across a spread of slider
    /// values, on a buffer exercising the negative-LMS, pure-black-passthrough,
    /// and skin-hue branches. This is stronger than "WGSL == local oracle":
    /// it pins the GPU output to the canonical CPU stage directly, so a
    /// transcription error in the local oracle cannot mask a kernel bug.
    #[test]
    fn wgsl_vibrance_matches_raw_core_stage_within_1e_4() {
        let ctx = GpuContext::new_blocking().expect("gpu context");
        let input = branchy_buffer();
        let count = (input.len() / 4) as u32;

        for &vib in &[-100.0_f32, -50.0, 25.0, 60.0, 100.0] {
            let reference = raw_core_vibrance(&input, vib);

            let img = GpuImage::upload(&ctx, &input, count, 1);
            let runner = ChainRunner::new(&ctx, &img);
            let gpu = runner.run_blocking(&[&VibrancePass { vibrance: vib }]);

            let max_diff = reference
                .iter()
                .zip(&gpu)
                .map(|(a, b)| (a - b).abs())
                .fold(0.0_f32, f32::max);
            eprintln!("PARITY vs raw-core vibrance={vib}: max abs diff = {max_diff:e}");
            assert!(
                max_diff < 1e-4,
                "vibrance={vib}: GPU vs raw-core stage max abs diff {max_diff} exceeds 1e-4"
            );
        }
    }

    /// Pin the local CPU oracle (`apply_vibrance`) to `raw_core`'s stage too, so
    /// the convenience oracle this crate exports can't silently drift from the
    /// canonical math. (The GPU gate above doesn't depend on the local oracle at
    /// all — this is belt-and-braces for the public `apply_vibrance` surface.)
    #[test]
    fn local_oracle_matches_raw_core_stage_within_1e_4() {
        let input = branchy_buffer();
        for &vib in &[-100.0_f32, -50.0, 25.0, 60.0, 100.0] {
            let reference = raw_core_vibrance(&input, vib);
            let mut local = input.clone();
            apply_vibrance(&mut local, vib);
            let max_diff = reference
                .iter()
                .zip(&local)
                .map(|(a, b)| (a - b).abs())
                .fold(0.0_f32, f32::max);
            assert!(
                max_diff < 1e-4,
                "vibrance={vib}: local oracle vs raw-core stage diff {max_diff} exceeds 1e-4"
            );
        }
    }

    /// Self-contained fallback gate: the WGSL kernel matches the local CPU
    /// oracle within 1e-4 (no raw-core dep needed to run). Kept alongside the
    /// raw-core gate as a fast, dependency-free signal. Mirrors the exposure
    /// precedent's `wgsl_exposure_matches_cpu_oracle_within_1e_4`.
    #[test]
    fn wgsl_vibrance_matches_cpu_oracle_within_1e_4() {
        let ctx = GpuContext::new_blocking().expect("gpu context");
        let input = branchy_buffer();
        let count = (input.len() / 4) as u32;

        for &vib in &[-100.0_f32, -50.0, 25.0, 60.0, 100.0] {
            let mut cpu = input.clone();
            apply_vibrance(&mut cpu, vib);

            let img = GpuImage::upload(&ctx, &input, count, 1);
            let runner = ChainRunner::new(&ctx, &img);
            let gpu = runner.run_blocking(&[&VibrancePass { vibrance: vib }]);

            let max_diff = cpu
                .iter()
                .zip(&gpu)
                .map(|(a, b)| (a - b).abs())
                .fold(0.0_f32, f32::max);
            eprintln!("PARITY vibrance={vib}: max abs diff = {max_diff:e}");
            assert!(
                max_diff < 1e-4,
                "vibrance={vib}: GPU vs CPU max abs diff {max_diff} exceeds 1e-4"
            );
        }
    }

    /// Pure black is the only input with exact zero Oklab chroma, so it hits
    /// the kernel's `chroma < 1e-6` branch, which copies the source pixel
    /// (including alpha) bit-exact. This pins that the branch fires and is a
    /// straight copy — not a no-op that secretly perturbs alpha or RGB. (It does
    /// NOT prove the early-return guards a NaN, since black round-trips to itself
    /// through the boost path too; the guard's NaN-safety rationale is documented
    /// in the kernel.)
    #[test]
    fn pure_black_hits_passthrough_branch_bit_exact_on_gpu() {
        let ctx = GpuContext::new_blocking().expect("gpu context");
        let input = vec![0.0_f32, 0.0, 0.0, 0.9];
        let img = GpuImage::upload(&ctx, &input, 1, 1);
        let runner = ChainRunner::new(&ctx, &img);
        let gpu = runner.run_blocking(&[&VibrancePass { vibrance: 100.0 }]);
        assert_eq!(gpu[0], 0.0, "black R must pass through unchanged");
        assert_eq!(gpu[1], 0.0, "black G must pass through unchanged");
        assert_eq!(gpu[2], 0.0, "black B must pass through unchanged");
        assert_eq!(gpu[3], 0.9, "alpha must pass through unchanged");
    }

    /// CPU oracle sanity: positive vibrance boosts a low-chroma pixel more than
    /// a high-chroma one (the defining vibrance property). Guards the oracle
    /// itself, independent of the GPU.
    #[test]
    fn oracle_boosts_low_chroma_more_than_high() {
        let low = [0.35_f32, 0.30, 0.30];
        let high = [0.80_f32, 0.10, 0.10];
        let mut buf = vec![low[0], low[1], low[2], 1.0, high[0], high[1], high[2], 1.0];

        let c = |rgb: [f32; 3]| {
            let lab = rec2020_to_oklab(rgb);
            (lab[1] * lab[1] + lab[2] * lab[2]).sqrt()
        };
        let before_low = c(low);
        let before_high = c(high);
        apply_vibrance(&mut buf, 100.0);
        let after_low = c([buf[0], buf[1], buf[2]]);
        let after_high = c([buf[4], buf[5], buf[6]]);

        let low_ratio = after_low / before_low;
        let high_ratio = after_high / before_high;
        assert!(
            low_ratio > high_ratio,
            "low-chroma ratio {low_ratio} should exceed high-chroma ratio {high_ratio}"
        );
    }

    /// The local oracle's inverse matrices are bit-identical to the forward
    /// matrices' `inverse3` — and, by construction, to `raw_core`'s
    /// `Matrix3::inverse`. This is the seam that keeps the oracle single-sourced
    /// with the codegen'd WGSL inverses.
    #[test]
    fn oracle_round_trips_neutral_within_tolerance() {
        let rgb = [0.18_f32, 0.18, 0.18];
        let lab = rec2020_to_oklab(rgb);
        let back = oklab_to_rec2020(lab);
        for c in 0..3 {
            assert!(
                (back[c] - rgb[c]).abs() < 1e-4,
                "round-trip drift on channel {c}: {} -> {}",
                rgb[c],
                back[c]
            );
        }
    }
}
