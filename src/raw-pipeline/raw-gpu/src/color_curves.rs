//! Oklab secondary color curves GPU pass (#5041, Stage 22b).
//!
//! Scene-linear Oklab stage positioned immediately after `hsl` (Stage 22) and
//! before `clarity` (Stage 23). Mirrors `raw_core::stages::color_curves` on the
//! GPU: six 256-sample baked offset LUTs (`hue_vs_hue`, `hue_vs_sat`,
//! `hue_vs_luma`, `luma_vs_sat`, `sat_vs_sat`, `sat_vs_luma`), the neutral-axis
//! chroma gate (`CHROMA_GATE_C0 = 0.05` + `smoothstep(0.05, 0.10, C)`), and
//! the 24-iteration Rec.2020 gamut-hull bisection + Reinhard soft-knee.

use crate::chain::Pass;
use crate::context::GpuContext;
use crate::hsl::{hsl_soft_compress, HSL_GAMUT_KNEE_FRACTION};
use crate::spatial::{encode_simple, pool_data_storage};

/// Number of samples per baked secondary curve LUT.
pub const COLOR_CURVE_LUT_LEN: usize = 256;

/// Number of secondary color curves.
pub const NUM_COLOR_CURVES: usize = 6;

/// Total float length of the flat LUT storage buffer (`6 * 256 = 1536`).
pub const COLOR_CURVES_FLAT_LEN: usize = NUM_COLOR_CURVES * COLOR_CURVE_LUT_LEN;

const CHROMA_GATE_C0: f32 = 0.05;
const MAX_OKLAB_CHROMA: f32 = 0.32;
const COLOR_CURVE_HUE_MAX_RAD: f32 = 60.0_f32 * std::f32::consts::PI / 180.0;
const COLOR_CURVE_LUMA_MAX_SCALE: f32 = 0.30;

const REC2020_LUMA_R: f32 = 0.26270021;
const REC2020_LUMA_G: f32 = 0.67799807;
const REC2020_LUMA_B: f32 = 0.05930172;

const GAMUT_EPS: f32 = 1e-5;
const GAMUT_BISECT_ITERS: usize = 24;

#[repr(C)]
#[derive(Clone, Copy, bytemuck::Pod, bytemuck::Zeroable)]
struct ColorCurvesGpuParams {
    chroma_gate_c0: f32,
    count: u32,
    is_identity: u32,
    _pad: u32,
}

mod inputs;
pub use inputs::{ColorCurveInputs, ColorCurvePoints};

#[derive(Clone, Copy)]
struct BakedLut {
    offsets: [f32; COLOR_CURVE_LUT_LEN],
    is_identity: bool,
}

impl Default for BakedLut {
    fn default() -> Self {
        Self {
            offsets: [0.0; COLOR_CURVE_LUT_LEN],
            is_identity: true,
        }
    }
}

/// Free-function identity predicate matching `display_tone_curve_is_identity`.
pub fn color_curves_is_identity(inputs: &ColorCurveInputs) -> bool {
    inputs.is_identity()
}

fn bake_curve_lut(points: &ColorCurvePoints<'_>, periodic: bool) -> BakedLut {
    if points.is_empty() {
        return BakedLut::default();
    }
    let mut knots: Vec<(f32, f32)> = points
        .iter()
        .filter(|(x, y)| x.is_finite() && y.is_finite())
        .map(|(x, y)| {
            let xc = if periodic {
                x.clamp(0.0, 1.0).rem_euclid(1.0)
            } else {
                x.clamp(0.0, 1.0)
            };
            (xc, y.clamp(0.0, 1.0))
        })
        .collect();
    if knots.is_empty() {
        return BakedLut::default();
    }
    knots.sort_by(|a, b| a.0.partial_cmp(&b.0).unwrap_or(std::cmp::Ordering::Equal));
    let mut dedup: Vec<(f32, f32)> = Vec::with_capacity(knots.len());
    for (x, y) in knots {
        if let Some(last) = dedup.last_mut() {
            if (x - last.0).abs() < 1e-5 {
                *last = (x, y);
                continue;
            }
        }
        dedup.push((x, y));
    }
    if dedup.iter().all(|&(_, y)| (y - 0.5).abs() < 1e-6) {
        return BakedLut::default();
    }
    if dedup.len() == 1 {
        let offset = (dedup[0].1 - 0.5).clamp(-0.5, 0.5);
        return BakedLut {
            offsets: [offset; COLOR_CURVE_LUT_LEN],
            is_identity: offset.abs() < 1e-6,
        };
    }

    let mut offsets = [0.0f32; COLOR_CURVE_LUT_LEN];
    if periodic {
        bake_periodic_hermite(&dedup, &mut offsets);
    } else {
        bake_clamped_hermite(&dedup, &mut offsets);
    }
    let is_identity = offsets.iter().all(|d| d.abs() < 1e-6);
    BakedLut {
        offsets,
        is_identity,
    }
}

fn bake_periodic_hermite(knots: &[(f32, f32)], offsets: &mut [f32; COLOR_CURVE_LUT_LEN]) {
    let n = knots.len();
    let mut h = vec![0.0f32; n];
    let mut delta = vec![0.0f32; n];
    for k in 0..n {
        let next = (k + 1) % n;
        let hk = if k + 1 < n {
            knots[next].0 - knots[k].0
        } else {
            (knots[0].0 + 1.0) - knots[k].0
        };
        let hk = hk.max(1e-5);
        h[k] = hk;
        delta[k] = (knots[next].1 - knots[k].1) / hk;
    }

    let mut m = vec![0.0f32; n];
    for k in 0..n {
        let prev = (k + n - 1) % n;
        let dl = delta[prev];
        let dr = delta[k];
        if dl * dr > 0.0 {
            let hl = h[prev];
            let hr = h[k];
            let w1 = 2.0 * hr + hl;
            let w2 = hr + 2.0 * hl;
            m[k] = (w1 + w2) / (w1 / dl + w2 / dr);
        }
    }
    for k in 0..n {
        let next = (k + 1) % n;
        let dk = delta[k];
        if dk.abs() < 1e-7 {
            m[k] = 0.0;
            m[next] = 0.0;
        } else {
            let alpha = m[k] / dk;
            let beta = m[next] / dk;
            let r2 = alpha * alpha + beta * beta;
            if r2 > 9.0 {
                let tau = 3.0 / r2.sqrt();
                m[k] = tau * alpha * dk;
                m[next] = tau * beta * dk;
            }
        }
    }

    for (i, slot) in offsets.iter_mut().enumerate() {
        let u = i as f32 / COLOR_CURVE_LUT_LEN as f32;
        let (k, local_u) = if u < knots[0].0 {
            (n - 1, u + 1.0 - knots[n - 1].0)
        } else {
            let mut seg = n - 1;
            for s in 0..(n - 1) {
                if u >= knots[s].0 && u < knots[s + 1].0 {
                    seg = s;
                    break;
                }
            }
            (seg, u - knots[seg].0)
        };
        let next = (k + 1) % n;
        let t = (local_u / h[k]).clamp(0.0, 1.0);
        let y = hermite(t, knots[k].1, knots[next].1, h[k] * m[k], h[k] * m[next]);
        *slot = (y.clamp(0.0, 1.0) - 0.5).clamp(-0.5, 0.5);
    }
}

fn bake_clamped_hermite(knots: &[(f32, f32)], offsets: &mut [f32; COLOR_CURVE_LUT_LEN]) {
    let n = knots.len();
    let mut h = vec![0.0f32; n - 1];
    let mut delta = vec![0.0f32; n - 1];
    for k in 0..(n - 1) {
        let hk = (knots[k + 1].0 - knots[k].0).max(1e-5);
        h[k] = hk;
        delta[k] = (knots[k + 1].1 - knots[k].1) / hk;
    }

    let mut m = vec![0.0f32; n];
    m[0] = delta[0];
    m[n - 1] = delta[n - 2];
    for k in 1..(n - 1) {
        let dl = delta[k - 1];
        let dr = delta[k];
        if dl * dr > 0.0 {
            let hl = h[k - 1];
            let hr = h[k];
            let w1 = 2.0 * hr + hl;
            let w2 = hr + 2.0 * hl;
            m[k] = (w1 + w2) / (w1 / dl + w2 / dr);
        }
    }
    for k in 0..(n - 1) {
        let dk = delta[k];
        if dk.abs() < 1e-7 {
            m[k] = 0.0;
            m[k + 1] = 0.0;
        } else {
            let alpha = m[k] / dk;
            let beta = m[k + 1] / dk;
            let r2 = alpha * alpha + beta * beta;
            if r2 > 9.0 {
                let tau = 3.0 / r2.sqrt();
                m[k] = tau * alpha * dk;
                m[k + 1] = tau * beta * dk;
            }
        }
    }

    for (i, slot) in offsets.iter_mut().enumerate() {
        let u = i as f32 / (COLOR_CURVE_LUT_LEN - 1) as f32;
        let y = if u <= knots[0].0 {
            knots[0].1
        } else if u >= knots[n - 1].0 {
            knots[n - 1].1
        } else {
            let mut seg = n - 2;
            for s in 0..(n - 1) {
                if u >= knots[s].0 && u <= knots[s + 1].0 {
                    seg = s;
                    break;
                }
            }
            let t = ((u - knots[seg].0) / h[seg]).clamp(0.0, 1.0);
            hermite(
                t,
                knots[seg].1,
                knots[seg + 1].1,
                h[seg] * m[seg],
                h[seg] * m[seg + 1],
            )
        };
        *slot = (y.clamp(0.0, 1.0) - 0.5).clamp(-0.5, 0.5);
    }
}

#[inline]
fn hermite(t: f32, y0: f32, y1: f32, m0: f32, m1: f32) -> f32 {
    let t2 = t * t;
    let t3 = t2 * t;
    let h00 = 2.0 * t3 - 3.0 * t2 + 1.0;
    let h10 = t3 - 2.0 * t2 + t;
    let h01 = -2.0 * t3 + 3.0 * t2;
    let h11 = t3 - t2;
    h00 * y0 + h10 * m0 + h01 * y1 + h11 * m1
}

#[inline]
fn sample_periodic(lut: &BakedLut, u: f32) -> f32 {
    if lut.is_identity {
        return 0.0;
    }
    let pos = u.rem_euclid(1.0) * COLOR_CURVE_LUT_LEN as f32;
    let i0 = (pos.floor() as usize) & (COLOR_CURVE_LUT_LEN - 1);
    let i1 = (i0 + 1) & (COLOR_CURVE_LUT_LEN - 1);
    let frac = pos - pos.floor();
    lut.offsets[i0] * (1.0 - frac) + lut.offsets[i1] * frac
}

#[inline]
fn sample_clamped(lut: &BakedLut, u: f32) -> f32 {
    if lut.is_identity {
        return 0.0;
    }
    let pos = u.clamp(0.0, 1.0) * (COLOR_CURVE_LUT_LEN - 1) as f32;
    let i0 = (pos.floor() as usize).min(COLOR_CURVE_LUT_LEN - 1);
    let i1 = (i0 + 1).min(COLOR_CURVE_LUT_LEN - 1);
    let frac = pos - pos.floor();
    lut.offsets[i0] * (1.0 - frac) + lut.offsets[i1] * frac
}

// ── Oklab helpers (CPU oracle) ────────────────────────────────────────────────

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

#[inline]
fn bisect_gamut_hull(l: f32, a_hat: f32, b_hat: f32, c_high: f32) -> f32 {
    let mut lo = 0.0f32;
    let mut hi = c_high;
    for _ in 0..GAMUT_BISECT_ITERS {
        let mid = 0.5 * (lo + hi);
        let rgb = oklab_to_rec2020([l, a_hat * mid, b_hat * mid]);
        if rgb[0].min(rgb[1]).min(rgb[2]) >= -GAMUT_EPS {
            lo = mid;
        } else {
            hi = mid;
        }
    }
    lo
}

/// CPU oracle: applies the Oklab secondary color curves over an interleaved
/// RGBA f32 buffer (alpha untouched).
pub fn apply_color_curves(buf: &mut [f32], inputs: &ColorCurveInputs) {
    let luts = inputs.baked_luts();
    if luts.iter().all(|l| l.is_identity) {
        return;
    }

    for px in buf.chunks_exact_mut(4) {
        let rgb = [px[0], px[1], px[2]];
        let lab = rec2020_to_oklab(rgb);
        let (mut l, a, b) = (lab[0], lab[1], lab[2]);
        let c = (a * a + b * b).sqrt();

        if c < CHROMA_GATE_C0 {
            continue;
        }
        let chroma_gate = smoothstep_cpu(CHROMA_GATE_C0, 2.0 * CHROMA_GATE_C0, c);

        let mut deg = b.atan2(a).to_degrees();
        if deg < 0.0 {
            deg += 360.0;
        }
        let u_h = (deg / 360.0).rem_euclid(1.0);
        let u_c = (c / MAX_OKLAB_CHROMA).clamp(0.0, 1.0);
        let y_luma =
            (REC2020_LUMA_R * rgb[0] + REC2020_LUMA_G * rgb[1] + REC2020_LUMA_B * rgb[2]).max(1e-6);
        let u_l = (0.5 + 0.125 * (y_luma / 0.18).log2()).clamp(0.0, 1.0);

        let d_hvh = sample_periodic(&luts[0], u_h);
        let delta_hue_rad = chroma_gate * d_hvh * 2.0 * COLOR_CURVE_HUE_MAX_RAD;

        let d_hvs = sample_periodic(&luts[1], u_h);
        let d_lvs = sample_clamped(&luts[3], u_l);
        let d_svs = sample_clamped(&luts[4], u_c);
        let s_hvs = (1.0 + chroma_gate * 2.0 * d_hvs).max(0.0);
        let s_lvs = (1.0 + chroma_gate * 2.0 * d_lvs).max(0.0);
        let s_svs = (1.0 + chroma_gate * 2.0 * d_svs).max(0.0);
        let c_target = (c * s_hvs * s_lvs * s_svs).max(0.0);

        let d_hvl = sample_periodic(&luts[2], u_h);
        let d_svl = sample_clamped(&luts[5], u_c);
        let s_hvl = 1.0 + chroma_gate * 2.0 * COLOR_CURVE_LUMA_MAX_SCALE * d_hvl;
        let s_svl = 1.0 + chroma_gate * 2.0 * COLOR_CURVE_LUMA_MAX_SCALE * d_svl;
        // A globally active curve can leave this pixel untouched, including signed RGB.
        if delta_hue_rad == 0.0 && c_target == c && s_hvl * s_svl == 1.0 {
            continue;
        }
        l = (l * s_hvl * s_svl).max(0.0);

        let a_hat = a / c;
        let b_hat = b / c;
        let (sin_dh, cos_dh) = delta_hue_rad.sin_cos();
        let rot_a_hat = a_hat * cos_dh - b_hat * sin_dh;
        let rot_b_hat = a_hat * sin_dh + b_hat * cos_dh;

        let c_probe = c_target / HSL_GAMUT_KNEE_FRACTION;
        let rgb_probe = oklab_to_rec2020([l, rot_a_hat * c_probe, rot_b_hat * c_probe]);
        let out = if rgb_probe[0].min(rgb_probe[1]).min(rgb_probe[2]) >= -GAMUT_EPS {
            oklab_to_rec2020([l, rot_a_hat * c_target, rot_b_hat * c_target])
        } else {
            let c_hull = bisect_gamut_hull(l, rot_a_hat, rot_b_hat, c_probe);
            let geometry_distance =
                ((l - lab[0]).powi(2) + (rot_a_hat * c - a).powi(2) + (rot_b_hat * c - b).powi(2))
                    .sqrt();
            let input_in_gamut = rgb[0].min(rgb[1]).min(rgb[2]) >= -GAMUT_EPS;
            let c_out = hsl_soft_compress(c_target, c_hull, c, geometry_distance, input_in_gamut);
            oklab_to_rec2020([l, rot_a_hat * c_out, rot_b_hat * c_out])
        };
        px[0] = out[0];
        px[1] = out[1];
        px[2] = out[2];
    }
}

/// A GPU-resident Oklab secondary color-curves stage.
pub struct ColorCurvesPass<'a> {
    pub inputs: &'a ColorCurveInputs<'a>,
}

impl Pass for ColorCurvesPass<'_> {
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
        let (flat, is_id) = self.inputs.to_flat();
        let params = ColorCurvesGpuParams {
            chroma_gate_c0: CHROMA_GATE_C0,
            count: pixel_count,
            is_identity: u32::from(is_id),
            _pad: 0,
        };
        let lut_buf = pool_data_storage(ctx, bytemuck::cast_slice(&flat), "color-curves-lut");

        encode_simple(
            ctx,
            encoder,
            ctx.color_curves_pipeline(),
            bytemuck::bytes_of(&params),
            &[src, dst, lut_buf.as_ref()],
            pixel_count,
            "color-curves",
        );
    }
}

#[cfg(all(test, not(target_arch = "wasm32")))]
#[path = "color_curves/tests.rs"]
mod tests;
