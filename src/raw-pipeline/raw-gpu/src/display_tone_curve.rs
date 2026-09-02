//! Display-referred (post-AgX) tone curves — a WGSL port of
//! `raw_core::stages::display_tone_curve::apply` (ticket #2232).
//!
//! Adobe's `crs:ToneCurvePV2012*` — a DIFFERENT quantity from the
//! scene-linear `tone_curves` stage: this one runs POST-AgX, on a buffer
//! already bounded to `[0, 1]` by AgX's own Oklab gamut compression, and
//! evaluates each curve directly on that domain (no `REF_MAX` rescale).
//! The master curve applies to R, G and B INDEPENDENTLY with the same
//! curve function — matching Adobe Camera Raw's own point-curve behaviour,
//! NOT luma-coupled — then each channel's own curve applies on top.
//!
//! Three pieces (the per-stage template, mirroring `tone_curves.rs`):
//! 1. [`apply_display_tone_curve`] — the CPU oracle: a line-for-line port
//!    of `apply` over a flat RGBA f32 buffer (alpha untouched), via the
//!    [`prep`] evaluator.
//! 2. [`DisplayToneCurvePass`] — the GPU-resident [`Pass`]; carries the
//!    model-equivalent inputs (the four point curves) and prepares all four
//!    slots itself, so the production Pass gates itself with no raw-core
//!    dep.
//! 3. The headless parity test (`display_tone_curve/tests.rs`) — GPU vs the
//!    real `stages::display_tone_curve::apply`, `< 1e-4` across a matrix of
//!    cases (all-default no-op; master-only; per-channel-only; combined).

mod prep;

use crate::chain::Pass;
use crate::context::GpuContext;
use crate::spatial::{encode_simple, pool_data_storage};
use prep::{eval_curve_unit, prepare_curve, PreparedCurve, CURVE_CAP};

/// Per-curve slot stride in the flat storage buffer: `1 (len) + CURVE_CAP*3`.
/// Matches `SLOT_STRIDE` in `display_tone_curve.wgsl`.
const SLOT_STRIDE: usize = 1 + CURVE_CAP * 3;
/// Four slots: master, R, G, B.
const NUM_SLOTS: usize = 4;

/// Whether a point-curve's control points are identity (empty). Mirrors
/// `ToneCurve::is_identity` (`points.is_empty()`).
fn is_identity(points: &[(f32, f32)]) -> bool {
    points.is_empty()
}

/// `repr(C)` params uniform shared by the WGSL kernel
/// (`display_tone_curve.wgsl`). `count` is the RGBA pixel count; `_pad*`
/// round to 16 bytes.
#[repr(C)]
#[derive(Clone, Copy, bytemuck::Pod, bytemuck::Zeroable)]
struct Params {
    count: u32,
    _pad0: u32,
    _pad1: u32,
    _pad2: u32,
}

/// The CPU-side inputs the stage consumes — the model-equivalent
/// `display_tone_curve_{luma,red,green,blue}` fields. Held by both the
/// oracle and the [`DisplayToneCurvePass`] so the two share one source of
/// truth.
#[derive(Clone, Debug, Default)]
pub struct DisplayToneCurveInputs {
    /// `display_tone_curve_luma` (the PV2012 master curve) control points.
    /// Empty = identity.
    pub master: Vec<(f32, f32)>,
    /// `display_tone_curve_red` control points. Empty = identity.
    pub red: Vec<(f32, f32)>,
    /// `display_tone_curve_green` control points. Empty = identity.
    pub green: Vec<(f32, f32)>,
    /// `display_tone_curve_blue` control points. Empty = identity.
    pub blue: Vec<(f32, f32)>,
}

impl DisplayToneCurveInputs {
    /// `true` when all four curves are identity — the live builder's gate
    /// predicate, mirroring `stages::display_tone_curve::apply`'s own
    /// early-return.
    pub fn is_identity(&self) -> bool {
        is_identity(&self.master)
            && is_identity(&self.red)
            && is_identity(&self.green)
            && is_identity(&self.blue)
    }

    fn prepared_slots(&self) -> [PreparedCurve; NUM_SLOTS] {
        [
            prepare_curve(&self.master),
            prepare_curve(&self.red),
            prepare_curve(&self.green),
            prepare_curve(&self.blue),
        ]
    }

    /// Flatten the four prepared slots into the storage-buffer layout the
    /// kernel reads (`NUM_SLOTS * SLOT_STRIDE` floats).
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

/// Apply the display-referred tone curves across an interleaved RGBA f32
/// buffer (alpha untouched). This is the CPU oracle — a line-for-line port
/// of `raw_core::stages::display_tone_curve::apply`.
pub fn apply_display_tone_curve(buf: &mut [f32], inputs: &DisplayToneCurveInputs) {
    if inputs.is_identity() {
        return;
    }
    let [master, red, green, blue] = inputs.prepared_slots();

    for px in buf.chunks_exact_mut(4) {
        px[0] = eval_curve_unit(&red, eval_curve_unit(&master, px[0]));
        px[1] = eval_curve_unit(&green, eval_curve_unit(&master, px[1]));
        px[2] = eval_curve_unit(&blue, eval_curve_unit(&master, px[2]));
        // px[3] (alpha) untouched
    }
}

/// A GPU-resident display-referred tone-curves stage. Carries the
/// model-equivalent [`DisplayToneCurveInputs`]; prepares all four slots
/// itself. Uploads them to storage binding 3 and the pixel count to uniform
/// binding 0 inside `encode`.
pub struct DisplayToneCurvePass {
    pub inputs: DisplayToneCurveInputs,
}

impl Pass for DisplayToneCurvePass {
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
            _pad0: 0,
            _pad1: 0,
            _pad2: 0,
        };
        let flat = self.inputs.to_flat();
        let curves_buf = pool_data_storage(
            ctx,
            bytemuck::cast_slice(&flat),
            "display-tone-curve-slots",
        );

        encode_simple(
            ctx,
            encoder,
            ctx.display_tone_curve_pipeline(),
            bytemuck::bytes_of(&params),
            &[src, dst, curves_buf.as_ref()],
            pixel_count,
            "display-tone-curve",
        );
    }
}

/// `true` when a [`DisplayToneCurveInputs`] is identity — re-exported at the
/// module level so `live_chain.rs` can gate pass inclusion without reaching
/// into the struct's own inherent method (matches `color_grade_is_identity`'s
/// free-function convention).
pub fn display_tone_curve_is_identity(inputs: &DisplayToneCurveInputs) -> bool {
    inputs.is_identity()
}

// Parity tests live in a sibling file to keep this module under the 600-LOC
// budget (mirrors `tone_curves.rs`'s own split). Native test builds only —
// the headless GPU harness has no wasm path.
#[cfg(all(test, not(target_arch = "wasm32")))]
#[path = "display_tone_curve/tests.rs"]
mod tests;
