//! Colour-grading stage — display-linear Oklab three-zone tint (#275),
//! ported to the unified wgpu chain.
//!
//! Ports `raw_core::stages::color_grade::apply`: balance-warped
//! shadow/midtone/highlight smoothstep weights over an Oklab
//! `(Δa, Δb, ΔL)` offset per wheel, plus an unweighted global wheel,
//! injected POST-AgX before grain and the target-gamut conversion. All-
//! default saturations and luminances gate the pass off entirely
//! (neutral-preserving).
//!
//! Three pieces (the per-stage template, mirroring saturation):
//! 1. [`apply_color_grade`] — the CPU oracle: a line-for-line port over a
//!    flat RGBA f32 buffer using the same Oklab matrices the kernel's
//!    generated header carries.
//! 2. [`ColorGradePass`] — the GPU-resident [`Pass`]; carries the thirteen
//!    slider values and hoists the balance exponent + pre-scaled wheel
//!    offsets with raw-core's exact float sequence.
//! 3. The headless parity test (`color_grade/tests.rs`) — GPU vs this
//!    oracle AND vs the real raw-core stage, < 1e-4.

use crate::chain::Pass;
use crate::context::GpuContext;
use crate::spatial::encode_simple;

/// `repr(C)` params uniform shared by the WGSL kernel (`color_grade.wgsl`).
/// Wheel offsets ride `vec4` lanes so the std140 uniform layout is
/// unambiguous; `.w` is unused padding.
#[repr(C)]
#[derive(Clone, Copy, bytemuck::Pod, bytemuck::Zeroable)]
struct Params {
    shadow: [f32; 4],
    midtone: [f32; 4],
    highlight: [f32; 4],
    global: [f32; 4],
    balance_exp: f32,
    count: u32,
    _pad0: u32,
    _pad1: u32,
}

// ── Stage-local constants (verbatim from raw_core::stages::color_grade) ────
const COLOR_GRADE_CHROMA_K: f32 = 0.06;
const COLOR_GRADE_LUMA_K: f32 = 0.15;
const SLIDER_EPS: f32 = 1e-3;
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

/// One wheel's raw slider triple: `(hue°, saturation, luminance)` —
/// mirrors `raw_core::stages::color_grade::Wheel`.
pub type Wheel = [f32; 3];

/// The thirteen slider values, mirroring
/// `raw_core::stages::color_grade::ColorGradeSliders`. Duplicated rather
/// than imported because raw-core is only a dev-dependency here (the
/// parity test pins the two definitions together).
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct ColorGradeSliders {
    pub shadow: Wheel,
    pub midtone: Wheel,
    pub highlight: Wheel,
    pub global: Wheel,
    pub balance: f32,
}

/// `(Δa, Δb, ΔL)` for one wheel at unit weight; `None` at default.
fn wheel_offset(w: Wheel) -> Option<[f32; 3]> {
    let [hue, sat, lum] = w;
    if sat.abs() < SLIDER_EPS && lum.abs() < SLIDER_EPS {
        return None;
    }
    let h = hue.to_radians();
    let c = COLOR_GRADE_CHROMA_K * (sat / 100.0);
    Some([c * h.cos(), c * h.sin(), COLOR_GRADE_LUMA_K * (lum / 100.0)])
}

/// Hoist the per-render params exactly as
/// `raw_core::stages::color_grade::color_grade_params` does (same float
/// sequence): the balance exponent + the four pre-scaled wheel offsets.
/// Returns `(balance_exp, shadow, midtone, highlight, global)`.
#[allow(clippy::type_complexity)]
fn color_grade_params(
    s: &ColorGradeSliders,
) -> (f32, [f32; 3], [f32; 3], [f32; 3], [f32; 3]) {
    (
        (-s.balance / 100.0).exp2(),
        wheel_offset(s.shadow).unwrap_or([0.0; 3]),
        wheel_offset(s.midtone).unwrap_or([0.0; 3]),
        wheel_offset(s.highlight).unwrap_or([0.0; 3]),
        wheel_offset(s.global).unwrap_or([0.0; 3]),
    )
}

/// True when every saturation and luminance sits at default — the
/// whole-stage short-circuit the chain builders consult before enqueueing
/// the pass.
pub fn color_grade_is_identity(s: &ColorGradeSliders) -> bool {
    wheel_offset(s.shadow).is_none()
        && wheel_offset(s.midtone).is_none()
        && wheel_offset(s.highlight).is_none()
        && wheel_offset(s.global).is_none()
}

/// Hermite smoothstep, matching the WGSL builtin and raw-core's helper.
fn smoothstep(e0: f32, e1: f32, x: f32) -> f32 {
    let t = ((x - e0) / (e1 - e0)).clamp(0.0, 1.0);
    t * t * (3.0 - 2.0 * t)
}

/// Colour grading on an interleaved RGBA f32 buffer (alpha untouched).
/// The CPU oracle — a line-for-line port of
/// `raw_core::stages::color_grade::apply`. The whole-image identity
/// short-circuit is the caller's (the chain doesn't enqueue the pass).
pub fn apply_color_grade(buf: &mut [f32], sliders: &ColorGradeSliders) {
    let (balance_exp, shadow, midtone, highlight, global) = color_grade_params(sliders);
    for px in buf.chunks_exact_mut(4) {
        let yd = (LUMA_REC2020[0] * px[0] + LUMA_REC2020[1] * px[1] + LUMA_REC2020[2] * px[2])
            .clamp(0.0, 1.0);
        let yb = yd.powf(balance_exp);
        let ws = 1.0 - smoothstep(0.0, 0.5, yb);
        let wh = smoothstep(0.5, 1.0, yb);
        let wm = 1.0 - ws - wh;
        let da = global[0] + ws * shadow[0] + wm * midtone[0] + wh * highlight[0];
        let db = global[1] + ws * shadow[1] + wm * midtone[1] + wh * highlight[1];
        let dl = global[2] + ws * shadow[2] + wm * midtone[2] + wh * highlight[2];
        let lab = rec2020_to_oklab([px[0], px[1], px[2]]);
        let out = oklab_to_rec2020([(lab[0] + dl).clamp(0.0, 1.0), lab[1] + da, lab[2] + db]);
        px[0] = out[0];
        px[1] = out[1];
        px[2] = out[2];
        // px[3] (alpha) untouched
    }
}

/// A GPU-resident colour-grading stage. Carries the thirteen slider
/// values; a pure point op (no window data needed — tile-safe by
/// construction).
pub struct ColorGradePass {
    pub sliders: ColorGradeSliders,
}

impl Pass for ColorGradePass {
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
        let (balance_exp, shadow, midtone, highlight, global) = color_grade_params(&self.sliders);
        let lane = |v: [f32; 3]| [v[0], v[1], v[2], 0.0];

        let params = Params {
            shadow: lane(shadow),
            midtone: lane(midtone),
            highlight: lane(highlight),
            global: lane(global),
            balance_exp,
            count: pixel_count,
            _pad0: 0,
            _pad1: 0,
        };
        // Pooled per-pixel dispatch: params @0, src @1, dst @2 — 2 storage
        // buffers, well under the ≤4/stage budget.
        encode_simple(
            ctx,
            encoder,
            ctx.color_grade_pipeline(),
            bytemuck::bytes_of(&params),
            &[src, dst],
            pixel_count,
            "color-grade",
        );
    }
}

// The parity tests live in a sibling file (600-LOC budget). Native only.
#[cfg(all(test, not(target_arch = "wasm32")))]
#[path = "color_grade/tests.rs"]
mod tests;
