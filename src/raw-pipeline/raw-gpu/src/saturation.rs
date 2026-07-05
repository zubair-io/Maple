//! Saturation stage — a P2 scene-linear WGSL port (epic #925 / #990).
//!
//! The trickier sibling of vibrance: it rounds a pixel through Oklab, scales
//! chroma uniformly, and — for positive saturation — runs a gamut-hull
//! **bisection loop** with a Reinhard soft-knee to keep the result inside
//! Rec.2020. Ports `raw_core::stages::saturation::apply` (spec § 02; #269).
//!
//! Three pieces (the per-stage template, mirroring vibrance):
//! 1. [`apply_saturation`] — the CPU oracle: a line-for-line port of
//!    `raw_core::stages::saturation::apply_pixel` over a flat RGBA f32 buffer
//!    (alpha untouched), including `soft_compress` + `bisect_gamut_hull`.
//! 2. [`SaturationPass`] — the GPU-resident [`Pass`]; carries only the
//!    `saturation` slider value. Its kernel concatenates the generated color
//!    matrices (like vibrance) since it works in Oklab.
//! 3. The headless parity test ([`mod tests`], in `saturation/tests.rs`) — GPU
//!    vs `raw_core::stages::saturation::apply` (the real stage, via the
//!    test-only `raw-core` dev-dep) `< 1e-4` across a spread of slider values,
//!    on a buffer that exercises the desaturation, in-gamut-fast, and
//!    bisection-compress branches plus the near-neutral NaN guard.
//!
//! ## The bisection loop in WGSL
//!
//! WGSL has loops, so `bisect_gamut_hull`'s 24-iteration binary search ports
//! directly (the `display_encode` kernel uses the same shape). The two scene-
//! linear-specific differences from `display_encode` — a LOWER-BOUND-ONLY gamut
//! predicate (HDR > 1 must pass) and a fast path that returns the round-tripped
//! pixel rather than the input — are documented at the relevant lines in
//! `saturation.wgsl`. The near-neutral `c_in < 1e-6` guard is kept verbatim:
//! it is NaN-safety (`a/c_in` is 0/0 at exact zero chroma), not an optimization.

use crate::chain::Pass;
use crate::context::GpuContext;
use crate::spatial::encode_simple;

/// `repr(C)` params uniform shared by the WGSL kernel (`saturation.wgsl`).
/// `scale` is `1.0 + saturation / 100.0`; `count` is the RGBA pixel count;
/// `_pad*` round the struct to 16 bytes (WGSL uniform alignment).
#[repr(C)]
#[derive(Clone, Copy, bytemuck::Pod, bytemuck::Zeroable)]
struct Params {
    scale: f32,
    count: u32,
    _pad0: u32,
    _pad1: u32,
}

// ── Stage-local constants (verbatim from raw_core::stages::saturation) ──────
// Single-sourced by value with the Rust stage AND the WGSL kernel; the parity
// gate pins all three together. (Not codegen color matrices — stage-local
// scalars, inlined like scene_tone's LUMA_REC2020.)
const GAMUT_KNEE_FRACTION: f32 = 0.8;
const GAMUT_BISECT_ITERS: usize = 24;
const GAMUT_EPS: f32 = 1e-5;

// ── Oklab helpers (duplicated from raw_core::color::oklab) ────────────────
//
// raw-gpu has no raw-core dependency in the normal build, so these mirror the
// Oklab round-trip. They stay numerically identical to raw-core's; the same
// matrix constants `codegen` emits into the WGSL kernel feed both. The parity
// test pins the WGSL output to this oracle AND to the real raw-core stage.

type Mat3 = [[f32; 3]; 3];

const M_REC2020_TO_SRGB: Mat3 = [
    [1.6605, -0.5876, -0.0728],
    [-0.1246, 1.1329, -0.0083],
    [-0.0182, -0.1006, 1.1187],
];
// Verbatim copies of `raw_core::color::oklab::{M1_SRGB_TO_LMS, M2_LMS_TO_LAB}`
// (digit-for-digit; the literals carry more digits than f32 stores, which is
// intentional — truncating would silently diverge from the canonical source).
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
/// so the cached-inverse oracle is bit-identical to raw-core's `OnceLock` cache.
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

/// Reinhard-style smooth chroma compression. Mirrors
/// `raw_core::stages::saturation::soft_compress` verbatim, including both early
/// returns (`c_target ≤ c_thresh`, and `d_max ≤ 0 → c_hull`).
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

/// Bisect along the (L, a_hat, b_hat) Oklab ray for the largest chroma whose
/// Rec.2020 projection has all channels ≥ -GAMUT_EPS. Mirrors
/// `raw_core::stages::saturation::bisect_gamut_hull` — 24 iterations, returns the
/// in-gamut bracket `lo`.
#[inline]
fn bisect_gamut_hull(l: f32, a_hat: f32, b_hat: f32, c_high: f32) -> f32 {
    let mut lo = 0.0f32;
    let mut hi = c_high;
    for _ in 0..GAMUT_BISECT_ITERS {
        let mid = 0.5 * (lo + hi);
        let rgb = oklab_to_rec2020([l, a_hat * mid, b_hat * mid]);
        let min_c = rgb[0].min(rgb[1]).min(rgb[2]);
        if min_c >= -GAMUT_EPS {
            lo = mid;
        } else {
            hi = mid;
        }
    }
    lo
}

/// Per-pixel saturation with gamut-aware soft-compression on the chroma axis.
/// Line-for-line port of `raw_core::stages::saturation::apply_pixel`.
#[inline]
fn apply_pixel(rgb: [f32; 3], scale: f32) -> [f32; 3] {
    let lab = rec2020_to_oklab(rgb);
    let (l, a, b) = (lab[0], lab[1], lab[2]);

    // Near-neutral: chroma zero in any direction, scaling a no-op (and the hue
    // unit vector below would be ill-defined / NaN). Bit-exact passthrough.
    let c_in = (a * a + b * b).sqrt();
    if c_in < 1e-6 {
        return rgb;
    }

    let c_target = c_in * scale;
    let a_hat = a / c_in;
    let b_hat = b / c_in;

    // Desaturation (scale ≤ 1): gamut never tightens.
    if scale <= 1.0 {
        return oklab_to_rec2020([l, a_hat * c_target, b_hat * c_target]);
    }

    // Fast path: scaled target stays in gamut → return the round-tripped target.
    let lab_target = [l, a_hat * c_target, b_hat * c_target];
    let rgb_target = oklab_to_rec2020(lab_target);
    if rgb_target[0].min(rgb_target[1]).min(rgb_target[2]) >= -GAMUT_EPS {
        return rgb_target;
    }

    // Out of gamut: bisect for the hull, soft-compress toward it, never below c_in.
    let c_hull = bisect_gamut_hull(l, a_hat, b_hat, c_target);
    let c_floor = c_in;
    let c_out = soft_compress(c_target, c_hull).max(c_floor);
    oklab_to_rec2020([l, a_hat * c_out, b_hat * c_out])
}

/// Oklab-based saturation with gamut-aware soft-compression on an interleaved
/// RGBA f32 buffer (alpha untouched). This is the CPU oracle — a line-for-line
/// port of `raw_core::stages::saturation::apply` (spec § 02): chroma is scaled
/// uniformly by `1 + saturation/100`, and at positive saturation the result is
/// soft-compressed back toward the per-pixel Rec.2020 gamut hull along the same
/// Oklab hue line.
///
/// `saturation` is in [-100, +100]. The whole-image `|saturation| < 1e-3`
/// short-circuit is handled by the caller (the chain doesn't enqueue the pass),
/// mirroring raw-core's `apply` early-return. The per-pixel `chroma < 1e-6`
/// passthrough is preserved here and in the kernel (NaN guard).
pub fn apply_saturation(buf: &mut [f32], saturation: f32) {
    let scale = 1.0 + saturation / 100.0;
    for px in buf.chunks_exact_mut(4) {
        let out = apply_pixel([px[0], px[1], px[2]], scale);
        px[0] = out[0];
        px[1] = out[1];
        px[2] = out[2];
        // px[3] (alpha) untouched
    }
}

/// A GPU-resident saturation stage. Carries only its `saturation` slider value;
/// the device, pipeline, and ping-pong buffers come from the [`GpuContext`] /
/// [`ChainRunner`]. Builds its own params uniform + bind group inside `encode`.
pub struct SaturationPass {
    pub saturation: f32,
}

impl Pass for SaturationPass {
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
            scale: 1.0 + self.saturation / 100.0,
            count: pixel_count,
            _pad0: 0,
            _pad1: 0,
        };
        // Pooled per-pixel dispatch (P4b-core C3): params @0, src @1, dst @2.
        encode_simple(
            ctx,
            encoder,
            ctx.saturation_pipeline(),
            bytemuck::bytes_of(&params),
            &[src, dst],
            pixel_count,
            "saturation",
        );
    }
}

// The parity tests live in a sibling file to keep this module under the 600-LOC
// budget (mirrors raw-core's `auto_profile/tests.rs` split). Compiled only for
// native test builds — the headless GPU harness has no wasm path.
#[cfg(all(test, not(target_arch = "wasm32")))]
#[path = "saturation/tests.rs"]
mod tests;
