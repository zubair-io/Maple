//! Auto Profile per-pixel tone CURVE — a P2 view-transform WGSL port (#925 / #990).
//!
//! Ports `raw_core::view::auto_profile::apply::apply_curve` (spec #530 / #550):
//! the per-pixel, CLOSED-FORM evaluation of a fitted `ProfileCurve`. This is the
//! per-image tone curve, NOT the residual 3D LUT (that is a later, LUT-template
//! wave) — the whole curve is a small fixed-size bundle of per-image data:
//!   - three 32-anchor monotone piecewise-linear channel curves,
//!   - an optional 3×3 cross-channel matrix (applied after the curves),
//!   - Oklab corrections: a chroma multiplier, an (a, b) offset, an L offset,
//!     and two 5-anchor L-band correction LUTs (interpolated on Rec.709 luma).
//!
//! Three pieces (the per-stage template):
//! 1. [`apply_auto_profile_curve`] — the CPU oracle: a line-for-line port of
//!    `apply_curve` over a flat RGBA f32 buffer (alpha untouched). Takes the
//!    curve as the flat [`PROFILE_CURVE_FLAT_LEN`]-length representation
//!    (`ProfileCurve::to_flat`), since raw-gpu has no raw-core dep in production.
//! 2. [`AutoProfileCurvePass`] — the GPU-resident [`Pass`]; carries the flat
//!    curve. The kernel concatenates the generated color matrices (Oklab path).
//! 3. The headless parity test ([`mod tests`], in `auto_profile_curve/tests.rs`)
//!    — GPU vs the real `apply_curve` (via the test-only `raw-core` dev-dep)
//!    `< 1e-4` on BOTH an identity-matrix curve (exercises `compress_input` +
//!    `eval_channel` only) AND a non-identity curve with a matrix + Oklab
//!    corrections (exercises the matrix + Oklab + band path — the identity-only
//!    test alone would be a false green).
//!
//! ## The two flags are computed HERE (parity-critical, not passed in)
//!
//! `apply_curve` skips the matrix matmul on an identity matrix and skips the
//! entire Oklab block when every correction is at its no-op value (the #550
//! production case). An always-on Oklab round-trip drifts ~1e-4 on neutrals and
//! would breach the gate. raw-gpu has no raw-core dep in production, so this Pass
//! replicates apply.rs's `identity` / `apply_chroma` predicates verbatim (the
//! `> 1e-4` thresholds) — the production Pass gates itself; the test cross-checks
//! the same flags against raw-core.

use crate::chain::Pass;
use crate::context::GpuContext;
use crate::spatial::{encode_simple, pool_data_storage};

/// Flat f32 length of a serialized `ProfileCurve` — mirrors
/// `raw_core::view::auto_profile::curve::PROFILE_CURVE_FLAT_LEN`:
/// r/g/b anchors (3×32×2 = 192) + matrix (9) + chroma_boost (1) +
/// chroma_offset (2) + lightness_offset (1) + lightness_band_offsets (5) +
/// ab_band_offsets (10) = 220. The Pass + oracle take the curve in this layout.
pub const PROFILE_CURVE_FLAT_LEN: usize = 3 * 32 * 2 + 9 + 1 + 2 + 1 + 5 + 10;

// Flat-layout offsets (mirror ProfileCurve::to_flat / the WGSL kernel constants).
const ANCHORS: usize = 32;
const OFF_MATRIX: usize = 192;
const OFF_CHROMA_BOOST: usize = 201;
const OFF_CHROMA_OFFSET: usize = 202;
const OFF_LIGHTNESS_OFFSET: usize = 204;
const OFF_L_BAND: usize = 205;
const OFF_AB_BAND: usize = 210;

const IDENTITY_MATRIX: [f32; 9] = [1.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0];

/// `repr(C)` metadata uniform shared by the WGSL kernel (`CurveMeta`): the RGBA
/// pixel `count` + the two CPU-computed branch flags + padding to 16 bytes.
#[repr(C)]
#[derive(Clone, Copy, bytemuck::Pod, bytemuck::Zeroable)]
struct Meta {
    count: u32,
    identity: u32,
    apply_chroma: u32,
    _pad0: u32,
}

// ── Oklab helpers (duplicated from raw_core::color::oklab) ────────────────
// Same local copy the vibrance / saturation oracles use — single-sourced by
// value with the generated WGSL matrices; the parity test pins all three.

type Mat3 = [[f32; 3]; 3];

const M_REC2020_TO_SRGB: Mat3 = [
    [1.6605, -0.5876, -0.0728],
    [-0.1246, 1.1329, -0.0083],
    [-0.0182, -0.1006, 1.1187],
];
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
fn srgb_gamma_decode(y: f32) -> f32 {
    if y <= 0.04045 {
        y / 12.92
    } else {
        ((y + 0.055) / 1.055).powf(2.4)
    }
}

#[inline]
fn srgb_gamma(x: f32) -> f32 {
    let cl = x.clamp(0.0, 1.0);
    if cl <= 0.0031308 {
        cl * 12.92
    } else {
        1.055 * cl.powf(1.0 / 2.4) - 0.055
    }
}

#[inline]
fn mul3(m: &Mat3, v: [f32; 3]) -> [f32; 3] {
    [
        m[0][0] * v[0] + m[0][1] * v[1] + m[0][2] * v[2],
        m[1][0] * v[0] + m[1][1] * v[1] + m[1][2] * v[2],
        m[2][0] * v[0] + m[2][1] * v[1] + m[2][2] * v[2],
    ]
}

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

/// Soft-knee compression. Mirrors `apply::compress_input` verbatim (KNEE=0.95;
/// negatives clamp to 0; smooth asymptote to 1.0 above the knee).
#[inline]
fn compress_input(x: f32) -> f32 {
    let x = x.max(0.0);
    const KNEE: f32 = 0.95;
    if x <= KNEE {
        x
    } else {
        let over = (x - KNEE) / (1.0 - KNEE);
        KNEE + (1.0 - KNEE) * (over / (1.0 + over))
    }
}

/// Evaluate a 32-anchor channel curve at `v` in `[0, 1]` from the flat buffer.
/// `base` is the channel's first flat index; outputs are at `base + 2*idx + 1`.
/// Mirrors `curve::eval_channel`.
#[inline]
fn eval_channel(flat: &[f32], base: usize, v: f32) -> f32 {
    let v = v.clamp(0.0, 1.0);
    let scaled = v * (ANCHORS - 1) as f32;
    let lo = scaled.floor() as usize;
    let hi = (lo + 1).min(ANCHORS - 1);
    let t = scaled - lo as f32;
    let lo_y = flat[base + 2 * lo + 1];
    let hi_y = flat[base + 2 * hi + 1];
    lo_y + (hi_y - lo_y) * t
}

/// Whether the flat curve's matrix slice is the identity matrix (skip the matmul).
/// Mirrors `apply_curve`'s `m == &IDENTITY_MATRIX`.
fn matrix_is_identity(flat: &[f32]) -> bool {
    flat[OFF_MATRIX..OFF_MATRIX + 9] == IDENTITY_MATRIX
}

/// Whether the Oklab correction block runs. Mirrors `apply_curve`'s `apply_chroma`
/// predicate (apply.rs) verbatim — the `> 1e-4` thresholds on chroma_boost,
/// chroma_offset, lightness_offset, and the two band LUTs.
fn should_apply_chroma(flat: &[f32]) -> bool {
    let chroma_boost = flat[OFF_CHROMA_BOOST];
    let chroma_off = [flat[OFF_CHROMA_OFFSET], flat[OFF_CHROMA_OFFSET + 1]];
    let l_off = flat[OFF_LIGHTNESS_OFFSET];
    let l_band = &flat[OFF_L_BAND..OFF_L_BAND + 5];
    let ab_band = &flat[OFF_AB_BAND..OFF_AB_BAND + 10];
    let any_l_band = l_band.iter().any(|v| v.abs() > 1e-4);
    let any_ab_band = ab_band.iter().any(|v| v.abs() > 1e-4);
    (chroma_boost - 1.0).abs() > 1e-4
        || chroma_off[0].abs() > 1e-4
        || chroma_off[1].abs() > 1e-4
        || l_off.abs() > 1e-4
        || any_l_band
        || any_ab_band
}

/// Apply a flat `ProfileCurve` to an interleaved RGBA f32 buffer (alpha
/// untouched). This is the CPU oracle — a line-for-line port of
/// `raw_core::view::auto_profile::apply::apply_curve` (which operates on packed
/// RGB; here the RGB lanes of each RGBA pixel are transformed identically and the
/// alpha lane is carried through). `flat` must be [`PROFILE_CURVE_FLAT_LEN`] long.
///
/// # Panics
/// Panics if `flat.len() != PROFILE_CURVE_FLAT_LEN`.
pub fn apply_auto_profile_curve(buf: &mut [f32], flat: &[f32]) {
    assert_eq!(
        flat.len(),
        PROFILE_CURVE_FLAT_LEN,
        "auto-profile curve flat length must be {PROFILE_CURVE_FLAT_LEN}"
    );
    let identity = matrix_is_identity(flat);
    let apply_chroma = should_apply_chroma(flat);
    let chroma_boost = flat[OFF_CHROMA_BOOST];
    let chroma_off = [flat[OFF_CHROMA_OFFSET], flat[OFF_CHROMA_OFFSET + 1]];
    let l_off = flat[OFF_LIGHTNESS_OFFSET];

    for px in buf.chunks_exact_mut(4) {
        let r0 = compress_input(px[0]);
        let g0 = compress_input(px[1]);
        let b0 = compress_input(px[2]);
        let (r1, g1, b1) = if identity {
            (r0, g0, b0)
        } else {
            let m = OFF_MATRIX;
            let r_lin = srgb_gamma_decode(r0);
            let g_lin = srgb_gamma_decode(g0);
            let b_lin = srgb_gamma_decode(b0);
            let r_adapt = flat[m] * r_lin + flat[m + 1] * g_lin + flat[m + 2] * b_lin;
            let g_adapt = flat[m + 3] * r_lin + flat[m + 4] * g_lin + flat[m + 5] * b_lin;
            let b_adapt = flat[m + 6] * r_lin + flat[m + 7] * g_lin + flat[m + 8] * b_lin;
            (srgb_gamma(r_adapt), srgb_gamma(g_adapt), srgb_gamma(b_adapt))
        };
        let mut r2 = eval_channel(flat, 0, r1);
        let mut g2 = eval_channel(flat, ANCHORS * 2, g1);
        let mut b2 = eval_channel(flat, ANCHORS * 4, b1);
        if apply_chroma {
            let lab = rec2020_to_oklab([r2, g2, b2]);
            // Bin by Rec.709 luma on the post-curve+matrix RGB (matches fit-time
            // binning). 5 anchors at Y = 0/0.25/0.5/0.75/1.0.
            let y_post = (0.2126 * r2 + 0.7152 * g2 + 0.0722 * b2).clamp(0.0, 1.0);
            let scaled_pos = y_post * 4.0;
            let lo = scaled_pos.floor() as usize;
            let hi = (lo + 1).min(4);
            let t = scaled_pos - lo as f32;
            let band_l = flat[OFF_L_BAND + lo] * (1.0 - t) + flat[OFF_L_BAND + hi] * t;
            let band_a = flat[OFF_AB_BAND + 2 * lo] * (1.0 - t) + flat[OFF_AB_BAND + 2 * hi] * t;
            let band_b =
                flat[OFF_AB_BAND + 2 * lo + 1] * (1.0 - t) + flat[OFF_AB_BAND + 2 * hi + 1] * t;
            let scaled = [
                lab[0] + l_off + band_l,
                lab[1] * chroma_boost + chroma_off[0] + band_a,
                lab[2] * chroma_boost + chroma_off[1] + band_b,
            ];
            let back = oklab_to_rec2020(scaled);
            r2 = back[0];
            g2 = back[1];
            b2 = back[2];
        }
        px[0] = r2;
        px[1] = g2;
        px[2] = b2;
        // px[3] (alpha) untouched
    }
}

/// A GPU-resident Auto Profile curve stage. Carries the flat `ProfileCurve`
/// ([`PROFILE_CURVE_FLAT_LEN`] floats). Computes the `identity` / `apply_chroma`
/// branch flags itself (replicating apply.rs's predicates) so the production Pass
/// gates itself without a raw-core dependency. Uploads the curve to storage
/// binding 3 and the metadata to uniform binding 0 inside `encode`.
pub struct AutoProfileCurvePass {
    /// Flat `ProfileCurve` (`ProfileCurve::to_flat()` output, length
    /// [`PROFILE_CURVE_FLAT_LEN`]).
    pub flat_curve: Vec<f32>,
}

impl Pass for AutoProfileCurvePass {
    fn encode(
        &self,
        ctx: &GpuContext,
        encoder: &mut wgpu::CommandEncoder,
        src: &wgpu::Buffer,
        dst: &wgpu::Buffer,
        dims: (u32, u32),
    ) {
        assert_eq!(
            self.flat_curve.len(),
            PROFILE_CURVE_FLAT_LEN,
            "auto-profile curve flat length must be {PROFILE_CURVE_FLAT_LEN}"
        );
        let (width, height) = dims;
        let pixel_count = width * height;

        let meta = Meta {
            count: pixel_count,
            identity: matrix_is_identity(&self.flat_curve) as u32,
            apply_chroma: should_apply_chroma(&self.flat_curve) as u32,
            _pad0: 0,
        };
        // Curve params in a READ-ONLY STORAGE buffer (4-byte stride). A uniform
        // `array<f32, N>` would get a 16-byte per-element stride and silently
        // misalign — the analog of white_balance's mat3x3 column-major trap.
        // POOLED (P4b-core C3): the fitted curve is session-constant — uploaded
        // once per chain shape, reused every tick (not re-uploaded on a hit).
        let curve_buf = pool_data_storage(
            ctx,
            bytemuck::cast_slice(&self.flat_curve),
            "auto-profile-curve-params",
        );

        // Pooled 4-binding dispatch: meta @0, src @1, dst @2, curve @3.
        encode_simple(
            ctx,
            encoder,
            ctx.auto_profile_curve_pipeline(),
            bytemuck::bytes_of(&meta),
            &[src, dst, curve_buf.as_ref()],
            pixel_count,
            "auto-profile-curve",
        );
    }
}

// Parity tests live in a sibling file to keep this module under the 600-LOC
// budget (mirrors raw-core's `auto_profile/tests.rs` split). Native test builds
// only — the headless GPU harness has no wasm path.
#[cfg(all(test, not(target_arch = "wasm32")))]
#[path = "auto_profile_curve/tests.rs"]
mod tests;
