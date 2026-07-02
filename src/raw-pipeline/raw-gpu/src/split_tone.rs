//! Split-toning stage — display-linear Oklab a/b tint (#1111, tone/zoom
//! design § 10.3), ported to the unified wgpu chain.
//!
//! Ports `raw_core::stages::split_tone::apply`: a balance-shifted
//! shadow/highlight Oklab chroma tint injected POST-AgX, before grain and
//! the target-gamut conversion. L is untouched (tone-invariant); zero
//! saturations gate the pass off entirely (neutral-preserving).
//!
//! Three pieces (the per-stage template, mirroring saturation):
//! 1. [`apply_split_tone`] — the CPU oracle: a line-for-line port over a
//!    flat RGBA f32 buffer using the same Oklab matrices the kernel's
//!    generated header carries.
//! 2. [`SplitTonePass`] — the GPU-resident [`Pass`]; carries the five
//!    slider values and hoists the weight exponents + pre-scaled hue
//!    vectors with raw-core's exact float sequence.
//! 3. The headless parity test (`split_tone/tests.rs`) — GPU vs this
//!    oracle AND vs the real raw-core stage, < 1e-4.

use crate::chain::Pass;
use crate::context::GpuContext;
use crate::spatial::encode_simple;

/// `repr(C)` params uniform shared by the WGSL kernel (`split_tone.wgsl`).
#[repr(C)]
#[derive(Clone, Copy, bytemuck::Pod, bytemuck::Zeroable)]
struct Params {
    gamma: f32,
    inv_gamma: f32,
    s_a: f32,
    s_b: f32,
    h_a: f32,
    h_b: f32,
    count: u32,
    _pad0: u32,
}

// ── Stage-local constants (verbatim from raw_core::stages::split_tone) ─────
const SPLIT_TONE_K: f32 = 0.06;
const LUMA_REC2020: [f32; 3] = [0.2627, 0.6780, 0.0593];

// ── Oklab helpers (duplicated from raw_core::color::oklab, the same
//    constants the saturation/vibrance oracles carry) ───────────────────────
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

/// Hoist the per-render params exactly as `raw_core::stages::split_tone::
/// split_tone_params` does (same float sequence): the weight exponents +
/// the K·s/100-scaled hue vectors.
fn split_tone_params(
    shadow_hue: f32,
    shadow_sat: f32,
    highlight_hue: f32,
    highlight_sat: f32,
    balance: f32,
) -> (f32, f32, [f32; 2], [f32; 2]) {
    let gamma = (balance / 100.0).exp2();
    let inv_gamma = 1.0 / gamma;
    let hs = shadow_hue.to_radians();
    let hh = highlight_hue.to_radians();
    let s_vec = [
        SPLIT_TONE_K * (shadow_sat / 100.0) * hs.cos(),
        SPLIT_TONE_K * (shadow_sat / 100.0) * hs.sin(),
    ];
    let h_vec = [
        SPLIT_TONE_K * (highlight_sat / 100.0) * hh.cos(),
        SPLIT_TONE_K * (highlight_sat / 100.0) * hh.sin(),
    ];
    (gamma, inv_gamma, s_vec, h_vec)
}

/// Split toning on an interleaved RGBA f32 buffer (alpha untouched). The
/// CPU oracle — a line-for-line port of `raw_core::stages::split_tone::
/// apply`. The whole-image zero-saturation short-circuit is the caller's
/// (the chain doesn't enqueue the pass).
pub fn apply_split_tone(
    buf: &mut [f32],
    shadow_hue: f32,
    shadow_sat: f32,
    highlight_hue: f32,
    highlight_sat: f32,
    balance: f32,
) {
    let (gamma, inv_gamma, s_vec, h_vec) = split_tone_params(
        shadow_hue,
        shadow_sat,
        highlight_hue,
        highlight_sat,
        balance,
    );
    for px in buf.chunks_exact_mut(4) {
        let yd = (LUMA_REC2020[0] * px[0] + LUMA_REC2020[1] * px[1] + LUMA_REC2020[2] * px[2])
            .clamp(0.0, 1.0);
        let ws = (1.0 - yd).powf(gamma);
        let wh = yd.powf(inv_gamma);
        let da = ws * s_vec[0] + wh * h_vec[0];
        let db = ws * s_vec[1] + wh * h_vec[1];
        let lab = rec2020_to_oklab([px[0], px[1], px[2]]);
        let out = oklab_to_rec2020([lab[0], lab[1] + da, lab[2] + db]);
        px[0] = out[0];
        px[1] = out[1];
        px[2] = out[2];
        // px[3] (alpha) untouched
    }
}

/// A GPU-resident split-toning stage. Carries the five slider values; a
/// pure point op (no window data needed — tile-safe by construction).
pub struct SplitTonePass {
    pub shadow_hue: f32,
    pub shadow_sat: f32,
    pub highlight_hue: f32,
    pub highlight_sat: f32,
    pub balance: f32,
}

impl Pass for SplitTonePass {
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
        let (gamma, inv_gamma, s_vec, h_vec) = split_tone_params(
            self.shadow_hue,
            self.shadow_sat,
            self.highlight_hue,
            self.highlight_sat,
            self.balance,
        );

        let params = Params {
            gamma,
            inv_gamma,
            s_a: s_vec[0],
            s_b: s_vec[1],
            h_a: h_vec[0],
            h_b: h_vec[1],
            count: pixel_count,
            _pad0: 0,
        };
        // Pooled per-pixel dispatch: params @0, src @1, dst @2 — 2 storage
        // buffers, well under the ≤4/stage budget.
        encode_simple(
            ctx,
            encoder,
            ctx.split_tone_pipeline(),
            bytemuck::bytes_of(&params),
            &[src, dst],
            pixel_count,
            "split-tone",
        );
    }
}

// The parity tests live in a sibling file (600-LOC budget). Native only.
#[cfg(all(test, not(target_arch = "wasm32")))]
#[path = "split_tone/tests.rs"]
mod tests;
