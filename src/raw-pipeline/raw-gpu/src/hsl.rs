//! 8-band HSL stage GPU pass (#1112, tone/zoom design § 10.4).
//!
//! Scene-linear Oklab stage positioned after saturation / before clarity.
//! Mirrors `raw_core::stages::hsl::apply_pixel` on the GPU: the same
//! normalized raised-cosine partition, chroma gate, and per-band
//! hue/sat/lum deltas. The WGSL kernel (`hsl.wgsl`) is compiled with the
//! generated color-matrix module (`compile_with_matrices`) for the Oklab
//! round-trip.
//!
//! This module provides:
//! 1. [`apply_hsl`] — the CPU oracle: a direct port over a flat RGBA f32
//!    buffer using the same Oklab matrices the WGSL kernel carries.
//! 2. [`HslPass`] — the GPU-resident [`Pass`]; carries the 24 slider values
//!    and hoists the derived params for the WGSL `Params` uniform.
//! 3. The headless parity test (`hsl/tests.rs`) — GPU vs CPU oracle AND vs
//!    the real raw-core stage, < 1e-4.

use crate::chain::Pass;
use crate::context::GpuContext;
use crate::spatial::encode_simple;

// ── Stage-local constants (verbatim from raw_core::stages::hsl) ───────────────
// These mirror HUE_CENTERS_DEG, BAND_HALF_WIDTH_DEG, CHROMA_GATE_C0, and
// HSL_HUE_MAX_RAD in raw-core. raw-core is a dev-dep only; copy the constants
// here (same pattern as saturation / vibrance oracles).

/// Number of HSL bands.
const NUM_BANDS: usize = 8;

/// Oklab hue centers for the 8 ACR-aligned bands (degrees), matching
/// `raw_core::stages::hsl::HUE_CENTERS_DEG`.
const HUE_CENTERS_DEG: [f32; NUM_BANDS] = [
    29.0,  // Red
    55.0,  // Orange
    110.0, // Yellow
    145.0, // Green
    195.0, // Aqua
    250.0, // Blue
    285.0, // Purple
    328.0, // Magenta
];

/// Raised-cosine half-width (67.5°), matching `raw_core::stages::hsl::BAND_HALF_WIDTH_DEG`.
const BAND_HALF_WIDTH_DEG: f32 = 67.5;

/// Chroma gate lower threshold, matching `raw_core::stages::hsl::CHROMA_GATE_C0`.
const CHROMA_GATE_C0: f32 = 0.05;

/// Max hue rotation at ±100 in radians, matching `raw_core::stages::hsl::HSL_HUE_MAX_RAD`.
const HSL_HUE_MAX_RAD: f32 = 30.0_f32 * std::f32::consts::PI / 180.0;

/// Circular angular distance (degrees) in [0, 180].
#[inline]
fn circular_delta_deg(h: f32, center: f32) -> f32 {
    let mut d = (h - center).abs() % 360.0;
    if d > 180.0 {
        d = 360.0 - d;
    }
    d
}

/// Raised-cosine weight for angular distance `delta_deg`.
#[inline]
fn raised_cosine_weight(delta_deg: f32, half_width_deg: f32) -> f32 {
    if delta_deg >= half_width_deg {
        return 0.0;
    }
    let t = delta_deg / half_width_deg;
    0.5 * (1.0 + (std::f32::consts::PI * t).cos())
}

/// `repr(C)` params uniform — must match the `Params` struct in `hsl.wgsl`.
///
/// WebGPU uniform address space requires array<f32, N> elements to have a
/// stride that is a multiple of 16 bytes. We pack each 8-element f32 array as
/// two [f32; 4] (= two vec4<f32>): index [0] = bands 0–3, [1] = bands 4–7.
/// This gives exact C layout compatibility with `bytemuck::bytes_of`.
///
/// Total: 6 × [f32;4] (96 bytes) + 4 × u32 (16 bytes) = 112 bytes.
#[repr(C)]
#[derive(Clone, Copy, bytemuck::Pod, bytemuck::Zeroable)]
struct HslGpuParams {
    /// Per-band hue rotation (radians): [bands 0-3], [bands 4-7].
    hue_rad: [[f32; 4]; 2],
    /// Per-band saturation delta: [bands 0-3], [bands 4-7].
    sat_delta: [[f32; 4]; 2],
    /// Per-band luminance shift: [bands 0-3], [bands 4-7].
    lum_shift: [[f32; 4]; 2],
    chroma_gate_c0: f32,
    count: u32,
    _pad0: u32,
    _pad1: u32,
}

// ── Oklab helpers (CPU oracle) ────────────────────────────────────────────────
// The oracle uses the same matrices as the WGSL kernel so the parity test
// compares equal implementations, not unrelated impls.

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

#[inline]
fn smoothstep_cpu(e0: f32, e1: f32, x: f32) -> f32 {
    let t = ((x - e0) / (e1 - e0)).clamp(0.0, 1.0);
    t * t * (3.0 - 2.0 * t)
}

/// CPU oracle: applies the HSL stage over an interleaved RGBA f32 buffer
/// (alpha untouched). Line-for-line port of `raw_core::stages::hsl::apply_pixel`,
/// using the same Oklab matrices the WGSL kernel carries.
pub fn apply_hsl(
    buf: &mut [f32],
    hue: &[f32; NUM_BANDS],
    sat: &[f32; NUM_BANDS],
    lum: &[f32; NUM_BANDS],
) {
    // Hoist params exactly as raw-core does (the is_identity flag let us skip early).
    let mut hue_rad = [0.0f32; NUM_BANDS];
    let mut sat_delta = [0.0f32; NUM_BANDS];
    let mut lum_shift = [0.0f32; NUM_BANDS];
    let mut is_identity = true;
    for i in 0..NUM_BANDS {
        if hue[i].abs() >= 1e-3 {
            hue_rad[i] = hue[i] / 100.0 * HSL_HUE_MAX_RAD;
            is_identity = false;
        }
        if sat[i].abs() >= 1e-3 {
            sat_delta[i] = sat[i] / 100.0;
            is_identity = false;
        }
        if lum[i].abs() >= 1e-3 {
            lum_shift[i] = lum[i] / 100.0;
            is_identity = false;
        }
    }
    if is_identity {
        return;
    }

    for px in buf.chunks_exact_mut(4) {
        let rgb = [px[0], px[1], px[2]];
        let lab = rec2020_to_oklab(rgb);
        let (l0, a0, b0) = (lab[0], lab[1], lab[2]);
        let c = (a0 * a0 + b0 * b0).sqrt();

        if c < CHROMA_GATE_C0 {
            continue;
        }
        let chroma_gate = smoothstep_cpu(CHROMA_GATE_C0, 2.0 * CHROMA_GATE_C0, c);

        let hue_deg = {
            let h = b0.atan2(a0).to_degrees();
            if h < 0.0 {
                h + 360.0
            } else {
                h
            }
        };
        let a_hat = a0 / c;
        let b_hat = b0 / c;

        // Normalized raised-cosine weights (same as WGSL kernel).
        let mut w_shape = [0.0f32; NUM_BANDS];
        let mut w_sum = 0.0f32;
        for band in 0..NUM_BANDS {
            let delta = circular_delta_deg(hue_deg, HUE_CENTERS_DEG[band]);
            w_shape[band] = raised_cosine_weight(delta, BAND_HALF_WIDTH_DEG);
            w_sum += w_shape[band];
        }
        if w_sum < 1e-6 {
            continue;
        }
        let w_norm_scale = chroma_gate / w_sum;

        let mut delta_hue_rad = 0.0f32;
        let mut delta_sat = 0.0f32;
        let mut delta_lum = 0.0f32;
        for band in 0..NUM_BANDS {
            if w_shape[band] < 1e-6 {
                continue;
            }
            let w = w_shape[band] * w_norm_scale;
            delta_hue_rad += hue_rad[band] * w;
            delta_sat += sat_delta[band] * w;
            delta_lum += lum_shift[band] * w;
        }

        let l_new = l0 * (1.0 + delta_lum);
        let c_new = (c * (1.0 + delta_sat)).max(0.0);
        let (sin_dh, cos_dh) = delta_hue_rad.sin_cos();
        let a_new = c_new * (a_hat * cos_dh - b_hat * sin_dh);
        let b_new = c_new * (a_hat * sin_dh + b_hat * cos_dh);

        let out = oklab_to_rec2020([l_new, a_new, b_new]);
        px[0] = out[0];
        px[1] = out[1];
        px[2] = out[2];
        // px[3] (alpha) untouched
    }
}

// ── HslPass ───────────────────────────────────────────────────────────────────

/// A GPU-resident 8-band HSL stage. Carries the 24 raw slider values.
/// A pure point op — no window data, tile-safe by construction.
pub struct HslPass {
    pub hue: [f32; NUM_BANDS],
    pub sat: [f32; NUM_BANDS],
    pub lum: [f32; NUM_BANDS],
}

impl HslPass {
    /// Returns true when all 24 sliders are at their default (0), meaning
    /// the pass is a bit-identical no-op. The live chain uses this to gate
    /// pass inclusion.
    pub fn is_noop(&self) -> bool {
        self.hue.iter().all(|v| v.abs() < 1e-3)
            && self.sat.iter().all(|v| v.abs() < 1e-3)
            && self.lum.iter().all(|v| v.abs() < 1e-3)
    }

    fn build_params(&self, pixel_count: u32) -> HslGpuParams {
        // Pack 8 per-band values into two [f32; 4] halves to satisfy WebGPU
        // uniform vec4 alignment (stride must be multiple of 16 bytes).
        let mut hue_rad_flat = [0.0f32; 8];
        let mut sat_delta_flat = [0.0f32; 8];
        let mut lum_shift_flat = [0.0f32; 8];
        for i in 0..NUM_BANDS {
            if self.hue[i].abs() >= 1e-3 {
                hue_rad_flat[i] = self.hue[i] / 100.0 * HSL_HUE_MAX_RAD;
            }
            if self.sat[i].abs() >= 1e-3 {
                sat_delta_flat[i] = self.sat[i] / 100.0;
            }
            if self.lum[i].abs() >= 1e-3 {
                lum_shift_flat[i] = self.lum[i] / 100.0;
            }
        }
        let pack = |v: &[f32; 8]| -> [[f32; 4]; 2] {
            [[v[0], v[1], v[2], v[3]], [v[4], v[5], v[6], v[7]]]
        };
        HslGpuParams {
            hue_rad: pack(&hue_rad_flat),
            sat_delta: pack(&sat_delta_flat),
            lum_shift: pack(&lum_shift_flat),
            chroma_gate_c0: CHROMA_GATE_C0,
            count: pixel_count,
            _pad0: 0,
            _pad1: 0,
        }
    }
}

impl Pass for HslPass {
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
        let p = self.build_params(pixel_count);
        // Uniform @0, src @1, dst @2 — 2 storage buffers (≤4 budget).
        encode_simple(
            ctx,
            encoder,
            ctx.hsl_pipeline(),
            bytemuck::bytes_of(&p),
            &[src, dst],
            pixel_count,
            "hsl",
        );
    }
}

// The parity tests live in a sibling file (600-LOC budget). Native only.
#[cfg(all(test, not(target_arch = "wasm32")))]
#[path = "hsl/tests.rs"]
mod tests;
