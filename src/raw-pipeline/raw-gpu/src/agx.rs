//! AgX view transform — a P2 view-transform WGSL port (epic #925 / #990).
//!
//! Ports `raw_core::view::agx::apply` (post-#435): the per-pixel AgX chain
//!   inset matrix
//!     -> ratio-preserving sigmoid (sigmoid the max channel, scale RGB by
//!        sigmoid(n)/n — hue invariant)
//!     -> outset matrix
//!     -> Oklab hue-preserving gamut compression to [0, 1]^3
//! with the sigmoid evaluated by sampling the SAME baked 512-entry LUT
//! (`agx_lut.bin`) raw-core's `sample_lut` reads — NOT the closed-form Jed
//! Smith sigmoid the GLSL shader recomputes. Matching raw-core's actual
//! runtime path is what lets the parity gate hold at `< 1e-4`: the closed-
//! form and the LUT differ ~1e-4, which the ratio scale + the outset matrix
//! (entries ~1.18) would amplify past the gate.
//!
//! Three pieces (the per-stage template):
//! 1. [`apply_agx`] — the CPU oracle: a line-for-line port of `agx_pixel`
//!    over a flat RGBA f32 buffer (alpha untouched), sampling the embedded
//!    LUT bytes (the same `agx_lut.bin` raw-core embeds).
//! 2. [`AgxPass`] — the GPU-resident [`Pass`]; carries `contrast`. The kernel
//!    concatenates the generated color matrices (Oklab round-trip) AND the
//!    generated AgX coeffs (inset/outset + scalars), and uploads the LUT to a
//!    read-only storage buffer (binding 3) like `auto_profile_curve`'s flat
//!    curve.
//! 3. The headless parity test ([`mod tests`], in `agx/tests.rs`) — GPU vs the
//!    real `raw_core::view::agx::apply` (via the test-only `raw-core` dev-dep)
//!    `< 1e-4`, on a buffer exercising the neutral axis, saturated primaries
//!    (the Oklab gamut-compress path), and deep shadow (the ratio-floor
//!    branch), at BOTH contrast 0 and a nonzero contrast (so the slope
//!    modulation is gated, not a contrast-0-only false green). The full #435
//!    transform — ratio sigmoid + outset + Oklab hue restoration — is the
//!    gated path.

use crate::chain::Pass;
use crate::context::GpuContext;
use crate::spatial::{encode_simple, pool_data_storage};

/// The baked AgX sigmoid LUT — byte-identical to raw-core's embedded copy
/// (`raw_core::view::agx` `include_bytes!`s the same file). 512 x f32 LE.
/// Uploaded to the kernel's storage binding 3 so the GPU samples the exact
/// table raw-core's `sample_lut` reads. The byte-identity of this file across
/// platforms is gated by raw-core's `lut_hash_matches_apple_bundle`.
const AGX_LUT_BYTES: &[u8] = include_bytes!("../../raw-core/src/view/agx_lut.bin");

/// LUT entry count — must match `raw_core::view::agx::AGX_LUT_SIZE` and the
/// `AGX_LUT_SIZE` const in the generated `agx_coeffs.wgsl`. Derived from the
/// embedded byte length (4 bytes per f32) so it can't drift from the file.
const AGX_LUT_SIZE: usize = AGX_LUT_BYTES.len() / 4;

// ── AgX scalar coefficients (mirror raw_core::view::agx + agx_coeffs.rs) ───
// These are the SAME constants the generated WGSL bakes; duplicated here for
// the CPU oracle. The parity test pins the oracle (and the GPU) to raw-core,
// so a transcription error here can't mask a kernel bug.
const AGX_MIN_EV: f32 = -10.0;
const AGX_MAX_EV: f32 = 6.5;
const AGX_MID_GRAY: f32 = 0.18;
/// `-MIN_EV / (MAX_EV - MIN_EV)` — normalized-log position of mid-gray.
const AGX_MID_NORM: f32 = -AGX_MIN_EV / (AGX_MAX_EV - AGX_MIN_EV);
/// Deep-shadow floor for the ratio scale (raw-core `RATIO_FLOOR`).
const AGX_RATIO_FLOOR: f32 = 1e-6;

type Mat3 = [[f32; 3]; 3];

/// Inset matrix (Rec.2020 -> AgX-Base-Rec.2020). f32 values identical to
/// `raw_core::view::agx::AGX_INSET_MATRIX` (and the generated WGSL `AGX_INSET`).
#[allow(clippy::excessive_precision)]
const AGX_INSET_MATRIX: Mat3 = [
    [
        8.591975135285663e-01,
        5.597524856454414e-02,
        8.482723790688949e-02,
    ],
    [
        5.919751352856634e-02,
        8.559752485645438e-01,
        8.482723790688945e-02,
    ],
    [
        5.919751352856627e-02,
        5.597524856454419e-02,
        8.848272379068893e-01,
    ],
];
/// Outset matrix (AgX-Base-Rec.2020 -> Rec.2020). Numerical inverse of INSET;
/// values identical to `raw_core::view::agx::AGX_OUTSET_MATRIX`.
#[allow(clippy::excessive_precision)]
const AGX_OUTSET_MATRIX: Mat3 = [
    [
        1.176003108089292e+00,
        -6.996906070568021e-02,
        -1.060340473836119e-01,
    ],
    [
        -7.399689191070798e-02,
        1.180030939294320e+00,
        -1.060340473836119e-01,
    ],
    [
        -7.399689191070784e-02,
        -6.996906070568031e-02,
        1.143965952616388e+00,
    ],
];

// ── Oklab pair (duplicated from raw_core::color::oklab, rec2020 pair) ───────
// Same local copy auto_profile_curve's oracle uses — single-sourced by value
// with the generated WGSL matrices; the parity test pins all of it.
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

/// In-gamut predicate with the fp-edge epsilon (EPS_HI = 1 + 1e-5, EPS_LO =
/// -1e-5). Mirrors raw-core's `in_unit_box`.
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
/// scaling at constant `L`. Mirrors `agx_hue_restoration::oklab_gamut_compress`,
/// which now delegates to `oklab_gamut::compress_to_unit_cube_oklab` (#1621):
/// a Reinhard soft-knee that rolls chroma off toward the hull instead of
/// clipping flat.
fn oklab_gamut_compress(rgb: [f32; 3]) -> [f32; 3] {
    const CHROMA_FLOOR: f32 = 1e-5;
    const COMPRESS_THRESHOLD: f32 = 0.8;

    let lab = rec2020_to_oklab(rgb);
    let (l, a, b) = (lab[0], lab[1], lab[2]);
    let c_in = (a * a + b * b).sqrt();
    if c_in <= CHROMA_FLOOR {
        return [
            rgb[0].clamp(0.0, 1.0),
            rgb[1].clamp(0.0, 1.0),
            rgb[2].clamp(0.0, 1.0),
        ];
    }
    let scale_chroma = |s: f32| oklab_to_rec2020([l, a * s, b * s]);
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

/// Parse the embedded LUT into `[f32; AGX_LUT_SIZE]` once. Mirrors raw-core's
/// `lut()` `OnceLock`.
fn lut() -> &'static Vec<f32> {
    static CELL: std::sync::OnceLock<Vec<f32>> = std::sync::OnceLock::new();
    CELL.get_or_init(|| {
        AGX_LUT_BYTES
            .chunks_exact(4)
            .map(|c| f32::from_le_bytes([c[0], c[1], c[2], c[3]]))
            .collect()
    })
}

/// Sample the AgX LUT with linear interpolation at normalized-log position
/// `x`. Mirrors raw-core's `sample_lut` index math exactly.
fn sample_lut(x: f32) -> f32 {
    let lut = lut();
    let x = x.clamp(0.0, 1.0);
    let idx = x * ((AGX_LUT_SIZE - 1) as f32);
    let i0 = idx.floor() as usize;
    let i1 = (i0 + 1).min(AGX_LUT_SIZE - 1);
    let f = idx - (i0 as f32);
    lut[i0] * (1.0 - f) + lut[i1] * f
}

/// Per-channel log2 encode + normalize to [0, 1]. Mirrors raw-core's
/// `log_encode`.
#[inline]
fn log_encode(channel: f32) -> f32 {
    let floor = AGX_MID_GRAY * AGX_MIN_EV.exp2();
    let clamped = channel.max(floor);
    let log_v = (clamped / AGX_MID_GRAY)
        .log2()
        .clamp(AGX_MIN_EV, AGX_MAX_EV);
    (log_v - AGX_MIN_EV) / (AGX_MAX_EV - AGX_MIN_EV)
}

/// Apply AgX to a single pixel. Line-for-line port of `raw_core` `agx_pixel`.
fn agx_pixel(scene: [f32; 3], slope: f32) -> [f32; 3] {
    let inset = mul3(&AGX_INSET_MATRIX, scene);

    // Ratio-preserving sigmoid (mirror of norm_sigmoid_ratio + the inner
    // sigmoid_curve closure).
    let sigmoid_curve = |x: f32| -> f32 {
        let norm = log_encode(x);
        let modulated = AGX_MID_NORM + (norm - AGX_MID_NORM) * slope;
        sample_lut(modulated)
    };
    let n = inset[0].max(inset[1]).max(inset[2]);
    let sig = if n <= AGX_RATIO_FLOOR {
        let v = sigmoid_curve(AGX_RATIO_FLOOR);
        [v, v, v]
    } else {
        let sn = sigmoid_curve(n);
        let ratio = sn / n;
        [inset[0] * ratio, inset[1] * ratio, inset[2] * ratio]
    };

    let out = mul3(&AGX_OUTSET_MATRIX, sig);
    oklab_gamut_compress(out)
}

/// Apply AgX across an interleaved RGBA f32 buffer (alpha untouched). This is
/// the CPU oracle — a line-for-line port of `raw_core::view::agx::apply` /
/// `agx_pixel`. `contrast` in [-100, +100]; 0 is the reference Sobotka sigmoid.
/// Input must be scene-linear Rec.2020; output is display-linear Rec.2020.
pub fn apply_agx(buf: &mut [f32], contrast: f32) {
    // slope = 1 + (contrast/100)*0.5. At +100 -> 1.5x, at -100 -> 0.5x.
    let slope = 1.0 + (contrast / 100.0) * 0.5;
    for px in buf.chunks_exact_mut(4) {
        let out = agx_pixel([px[0], px[1], px[2]], slope);
        px[0] = out[0];
        px[1] = out[1];
        px[2] = out[2];
        // px[3] (alpha) untouched
    }
}

/// `repr(C)` params uniform shared by the WGSL kernel (`agx.wgsl`). `count` is
/// the RGBA pixel count; `contrast` is the slider value; `_pad*` round to 16
/// bytes. (`params`, not `meta` — `meta` is a reserved WGSL keyword.)
#[repr(C)]
#[derive(Clone, Copy, bytemuck::Pod, bytemuck::Zeroable)]
struct Params {
    count: u32,
    contrast: f32,
    _pad0: u32,
    _pad1: u32,
}

/// A GPU-resident AgX view-transform stage. Carries `contrast` ([-100, +100];
/// 0 = reference Sobotka sigmoid). The device, pipeline, and ping-pong buffers
/// come from the [`GpuContext`] / [`ChainRunner`]; the baked LUT is uploaded
/// to storage binding 3 inside `encode`.
pub struct AgxPass {
    /// Contrast slider value in `[-100, +100]`. 0 is the reference sigmoid.
    pub contrast: f32,
}

impl Pass for AgxPass {
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
            contrast: self.contrast,
            _pad0: 0,
            _pad1: 0,
        };
        // Baked LUT in a READ-ONLY STORAGE buffer (4-byte stride). A uniform
        // array<f32> would get a 16-byte per-element stride and silently
        // misalign — same trap auto_profile_curve's flat-curve buffer dodges.
        // POOLED (P4b-core C3): the baked LUT is a constant — uploaded once per
        // chain shape, reused every tick (never re-uploaded on a same-sig hit).
        let lut_buf = pool_data_storage(ctx, AGX_LUT_BYTES, "agx-lut");

        // Pooled 4-binding dispatch: params @0, src @1, dst @2, LUT @3.
        encode_simple(
            ctx,
            encoder,
            ctx.agx_pipeline(),
            bytemuck::bytes_of(&params),
            &[src, dst, lut_buf.as_ref()],
            pixel_count,
            "agx",
        );
    }
}

// Parity tests live in a sibling file to keep this module under the 600-LOC
// budget (mirrors auto_profile_curve's `tests.rs` split). Native test builds
// only — the headless GPU harness has no wasm path.
#[cfg(all(test, not(target_arch = "wasm32")))]
#[path = "agx/tests.rs"]
mod tests;
