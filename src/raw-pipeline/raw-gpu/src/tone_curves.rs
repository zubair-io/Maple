//! User-authored tone curves — a P2 scene-linear WGSL port (epic #925 / #990).
//!
//! Ports `raw_core::stages::tone_curves::apply` (ticket #273 / #436): the
//! parametric region sliders + the per-channel point curves (luma / R / G / B),
//! applied in scene-linear Rec.2020. The runtime data is the PREPARED curves —
//! sorted/deduped/clamped knots + Fritsch-Carlson tangents — computed CPU-side
//! per curve (see [`prep`]; the analog of white_balance deriving its matrix once)
//! and uploaded to a storage buffer. The per-pixel kernel only evaluates; every
//! branch decision is a CPU-computed uniform flag (mirroring auto_profile_curve),
//! so parity holds past the slider epsilon edge.
//!
//! This is a DIFFERENT runtime-data shape from the residual 3D LUT: that uploads
//! a sampled grid (trilinear); this uploads CPU-derived per-image *coefficients*
//! (the prepared curves), the white_balance / auto_profile family.
//!
//! Three pieces (the per-stage template):
//! 1. [`apply_tone_curves`] — the CPU oracle: a line-for-line port of `apply`
//!    over a flat RGBA f32 buffer (alpha untouched), via the [`prep`] evaluator.
//! 2. [`ToneCurvesPass`] — the GPU-resident [`Pass`]; carries the model-equivalent
//!    inputs (parametric sliders + the four point curves + the mode). It computes
//!    the active flags + synthesises the parametric curve + prepares all five
//!    curve slots itself (replicating `apply`'s predicates), so the production
//!    Pass gates itself with no raw-core dep. No generated color matrices (luma is
//!    the inlined Rec.2020 weights).
//! 3. The headless parity test ([`mod tests`], in `tone_curves/tests.rs`) — GPU
//!    vs the real `stages::tone_curves::apply` `< 1e-4` across a MATRIX of cases
//!    (all-default no-op; PerChannel hue-shift; the same curves in RatioPreserving;
//!    parametric-only; luma-only; a combined case), so no single config is a false
//!    green for an untested branch.

mod prep;

use crate::chain::Pass;
use crate::context::GpuContext;
use crate::spatial::{encode_simple, pool_data_storage};
use prep::{
    build_parametric_knots, eval_curve_scene_linear, prepare_curve, prepare_curve_from_slice,
    PreparedCurve, CURVE_CAP,
};

/// Rec.2020 luma weights — inlined (mirror `mod::LUMA_REC2020` / the WGSL
/// `LUMA_*`), NOT the codegen color matrices.
const LUMA_REC2020: [f32; 3] = [0.2627, 0.6780, 0.0593];

/// Smallest parametric slider magnitude considered non-identity. Mirrors
/// `mod::PARAMETRIC_EPSILON`.
const PARAMETRIC_EPSILON: f32 = 1e-3;

/// Per-curve slot stride in the flat storage buffer: `1 (len) + CURVE_CAP*3`.
/// Matches `SLOT_STRIDE` in `tone_curves.wgsl`.
const SLOT_STRIDE: usize = 1 + CURVE_CAP * 3;
/// Five slots: parametric, luma, r, g, b.
const NUM_SLOTS: usize = 5;

/// Per-channel application mode. Mirrors `raw_core::ToneCurveMode`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CurveMode {
    /// Each R/G/B curve applies independently per-lane (hue shifts). Pre-#436
    /// default.
    PerChannel,
    /// The three R/G/B curves fold into one Rec.2020 luma scale (hue preserved).
    RatioPreserving,
}

/// `repr(C)` params uniform shared by the WGSL kernel (`tone_curves.wgsl`).
/// `count` is the RGBA pixel count; the three `*_active` flags + `mode` are the
/// CPU-computed branch decisions; `_pad*` round to 16 bytes. (`params`, not
/// `meta` — `meta` is a reserved WGSL keyword.)
#[repr(C)]
#[derive(Clone, Copy, bytemuck::Pod, bytemuck::Zeroable)]
struct Params {
    count: u32,
    parametric_active: u32,
    luma_active: u32,
    per_channel_active: u32,
    mode: u32,
    _pad0: u32,
    _pad1: u32,
    _pad2: u32,
}

/// Whether a point-curve's control points are identity (empty). Mirrors
/// `ToneCurve::is_identity` (`points.is_empty()`).
fn is_identity(points: &[(f32, f32)]) -> bool {
    points.is_empty()
}

/// Whether the parametric region sliders are active (any |slider| >=
/// PARAMETRIC_EPSILON). Mirrors `apply`'s `parametric_active`.
fn parametric_active(s: f32, d: f32, l: f32, h: f32) -> bool {
    s.abs() >= PARAMETRIC_EPSILON
        || d.abs() >= PARAMETRIC_EPSILON
        || l.abs() >= PARAMETRIC_EPSILON
        || h.abs() >= PARAMETRIC_EPSILON
}

/// The CPU-side inputs the stage consumes — the model-equivalent fields
/// `apply(img, model)` reads. Held by both the oracle and the [`ToneCurvesPass`]
/// so the two share one source of truth.
#[derive(Clone, Debug)]
pub struct ToneCurveInputs {
    /// Parametric region sliders (shadows, darks, lights, highlights), each
    /// `[-100, 100]`. Mirror `model.parametric_{shadows,darks,lights,highlights}`.
    pub parametric: [f32; 4],
    /// `tone_curve_luma` control points (`[0, 1]^2`). Empty = identity.
    pub luma: Vec<(f32, f32)>,
    /// `tone_curve_red` control points. Empty = identity.
    pub red: Vec<(f32, f32)>,
    /// `tone_curve_green` control points. Empty = identity.
    pub green: Vec<(f32, f32)>,
    /// `tone_curve_blue` control points. Empty = identity.
    pub blue: Vec<(f32, f32)>,
    /// Per-channel application mode.
    pub mode: CurveMode,
}

impl ToneCurveInputs {
    /// `(parametric_active, luma_active, per_channel_active)` — the three branch
    /// flags, computed exactly like `apply`. `per_channel_active` is "any of
    /// R/G/B non-identity" (the mode dispatch happens inside the kernel).
    fn flags(&self) -> (bool, bool, bool) {
        let [s, d, l, h] = self.parametric;
        let para = parametric_active(s, d, l, h);
        let luma = !is_identity(&self.luma);
        let per_channel =
            !is_identity(&self.red) || !is_identity(&self.green) || !is_identity(&self.blue);
        (para, luma, per_channel)
    }

    /// Prepare all five curve slots (parametric synthesised from the sliders).
    /// Slots whose flag is off are still prepared (cheap) but the kernel skips
    /// them via the flags; per-channel identity curves prepare to empty (0-knot)
    /// slots, which the kernel treats as pass-through (matching `apply`'s
    /// per-lane early-return).
    fn prepared_slots(&self) -> [PreparedCurve; NUM_SLOTS] {
        let [s, d, l, h] = self.parametric;
        let parametric = prepare_curve_from_slice(&build_parametric_knots(s, d, l, h));
        [
            parametric,
            prepare_curve(&self.luma),
            prepare_curve(&self.red),
            prepare_curve(&self.green),
            prepare_curve(&self.blue),
        ]
    }

    /// Flatten the five prepared slots into the storage-buffer layout the kernel
    /// reads (`NUM_SLOTS * SLOT_STRIDE` floats).
    fn to_flat(&self) -> Vec<f32> {
        let slots = self.prepared_slots();
        let mut flat = Vec::with_capacity(NUM_SLOTS * SLOT_STRIDE);
        for slot in &slots {
            flat.extend_from_slice(&slot.to_slot());
        }
        debug_assert_eq!(flat.len(), NUM_SLOTS * SLOT_STRIDE);
        flat
    }
}

/// Apply user tone curves across an interleaved RGBA f32 buffer (alpha
/// untouched). This is the CPU oracle — a line-for-line port of
/// `raw_core::stages::tone_curves::apply` (which operates on `Image` pixels; here
/// the RGB lanes of each RGBA pixel are transformed identically and the alpha
/// lane is carried through). Sequenced parametric -> luma -> per-channel, each
/// luma recompute reading the running pixel.
pub fn apply_tone_curves(buf: &mut [f32], inputs: &ToneCurveInputs) {
    let (para_on, luma_on, per_channel_on) = inputs.flags();
    let slots = inputs.prepared_slots();
    let (parametric, luma, red, green, blue) =
        (&slots[0], &slots[1], &slots[2], &slots[3], &slots[4]);

    for px in buf.chunks_exact_mut(4) {
        let mut p = [px[0], px[1], px[2]];

        if para_on {
            luma_coupled(&mut p, parametric);
        }
        if luma_on {
            luma_coupled(&mut p, luma);
        }
        if per_channel_on {
            match inputs.mode {
                CurveMode::PerChannel => {
                    // Per-lane, skip on v <= 0. Identity (empty) curve -> len 0
                    // -> v pass-through (matches `apply`'s per-lane early-return).
                    if p[0] > 0.0 {
                        p[0] = eval_curve_scene_linear(red, p[0]);
                    }
                    if p[1] > 0.0 {
                        p[1] = eval_curve_scene_linear(green, p[1]);
                    }
                    if p[2] > 0.0 {
                        p[2] = eval_curve_scene_linear(blue, p[2]);
                    }
                }
                CurveMode::RatioPreserving => {
                    let y_in =
                        LUMA_REC2020[0] * p[0] + LUMA_REC2020[1] * p[1] + LUMA_REC2020[2] * p[2];
                    if y_in > 0.0 {
                        let r_prime = eval_curve_scene_linear(red, y_in);
                        let g_prime = eval_curve_scene_linear(green, y_in);
                        let b_prime = eval_curve_scene_linear(blue, y_in);
                        let y_out = LUMA_REC2020[0] * r_prime
                            + LUMA_REC2020[1] * g_prime
                            + LUMA_REC2020[2] * b_prime;
                        let scale = y_out / y_in;
                        p[0] *= scale;
                        p[1] *= scale;
                        p[2] *= scale;
                    }
                }
            }
        }

        px[0] = p[0];
        px[1] = p[1];
        px[2] = p[2];
        // px[3] (alpha) untouched
    }
}

/// Luma-coupled apply of one prepared curve (hue-preserving): scale RGB by
/// `Y_new / Y_old`, skip on `Y_old <= 0`. Mirrors `apply_*_luma_coupled`.
#[inline]
fn luma_coupled(p: &mut [f32; 3], curve: &PreparedCurve) {
    let y_old = LUMA_REC2020[0] * p[0] + LUMA_REC2020[1] * p[1] + LUMA_REC2020[2] * p[2];
    if y_old <= 0.0 {
        return;
    }
    let y_new = eval_curve_scene_linear(curve, y_old);
    let scale = y_new / y_old;
    p[0] *= scale;
    p[1] *= scale;
    p[2] *= scale;
}

/// A GPU-resident tone-curves stage. Carries the model-equivalent
/// [`ToneCurveInputs`]; computes the branch flags + synthesises the parametric
/// curve + prepares all five slots itself (replicating `apply`'s predicates) so
/// the production Pass gates itself without a raw-core dependency. Uploads the
/// prepared slots to storage binding 3 and the flags/count to uniform binding 0
/// inside `encode`.
pub struct ToneCurvesPass {
    /// The model-equivalent stage inputs.
    pub inputs: ToneCurveInputs,
}

impl Pass for ToneCurvesPass {
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

        let (para_on, luma_on, per_channel_on) = self.inputs.flags();
        let mode = match self.inputs.mode {
            CurveMode::PerChannel => 0u32,
            CurveMode::RatioPreserving => 1u32,
        };
        let params = Params {
            count: pixel_count,
            parametric_active: para_on as u32,
            luma_active: luma_on as u32,
            per_channel_active: per_channel_on as u32,
            mode,
            _pad0: 0,
            _pad1: 0,
            _pad2: 0,
        };
        // Prepared curve slots in a READ-ONLY STORAGE buffer (4-byte stride). A
        // uniform array<f32> would get a 16-byte per-element stride and silently
        // misalign — the same trap auto_profile_curve's flat-curve buffer dodges.
        // POOLED (P4b-core C3): the prepared curves are session-constant — built
        // once per chain shape, reused every tick (not re-uploaded on a hit).
        let flat = self.inputs.to_flat();
        let curves_buf = pool_data_storage(ctx, bytemuck::cast_slice(&flat), "tone-curves-slots");

        // Pooled 4-binding dispatch: params @0, src @1, dst @2, curves @3.
        encode_simple(
            ctx,
            encoder,
            ctx.tone_curves_pipeline(),
            bytemuck::bytes_of(&params),
            &[src, dst, curves_buf.as_ref()],
            pixel_count,
            "tone-curves",
        );
    }
}

// Parity tests live in a sibling file to keep this module under the 600-LOC
// budget (mirrors auto_profile_curve's `tests.rs` split). Native test builds
// only — the headless GPU harness has no wasm path.
#[cfg(all(test, not(target_arch = "wasm32")))]
#[path = "tone_curves/tests.rs"]
mod tests;
