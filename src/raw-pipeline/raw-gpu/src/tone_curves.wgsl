// tone_curves.wgsl — user-authored tone curves (parametric region sliders +
// per-channel point curves), a P2 scene-linear stage (epic #925 / #990).
//
// Line-for-line WGSL port of `raw_core::stages::tone_curves::apply` and its
// `evaluator` (Fritsch-Carlson monotone cubic Hermite). The runtime data is the
// PREPARED curves — sorted/deduped/clamped knots + the Fritsch-Carlson tangents,
// computed CPU-side per curve (the analog of white_balance deriving its matrix
// CPU-side once) and uploaded to a storage buffer. The per-pixel kernel only
// EVALUATES; it carries NO `is_identity` branch logic (every branch decision is a
// CPU-computed uniform flag, mirroring auto_profile_curve), so parity holds past
// the slider epsilon edge instead of relying on float noise staying < 1e-4.
//
// Sequenced sub-steps within the ONE kernel (sequencing is automatic — each
// luma recompute reads the running pixel):
//   1. parametric curve (luma-coupled, hue-preserving)  — slot 0, gated by
//      `parametric_active`
//   2. tone_curve_luma  (luma-coupled, hue-preserving)  — slot 1, gated by
//      `luma_active`
//   3. per-channel R/G/B — gated by `per_channel_active`, dispatched on `mode`:
//        PerChannel (0): each curve applies per-lane (hue shifts) — slots 2/3/4
//        RatioPreserving (1): the three curves fold through Rec.2020 luma to one
//          scale factor (hue preserved)
//
// PARITY-CRITICAL invariants (mirrored verbatim from mod.rs / evaluator.rs):
//   * LUMA_REC2020 = [0.2627, 0.6780, 0.0593] (inlined, NOT the codegen matrices).
//   * eval_curve_scene_linear: REF_MAX = 4.0 both directions; len 0 -> v
//     (pass-through); len 1 -> knots[0].y * REF_MAX (constant, NOT pass-through).
//   * eval_monotonic_cubic: x<=knots[0].x -> knots[0].y; x>=knots[last].x ->
//     knots[last].y; else cubic Hermite on the bracketing segment with the
//     prepared tangents.
//   * Skip granularity per sub-step: luma-coupled steps skip on Y<=0 with Y
//     recomputed from the RUNNING pixel; PerChannel skips per-lane on v<=0;
//     RatioPreserving skips on Y_in<=0. RatioPreserving runs identity curves as
//     empty-knot pass-through (len 0 -> v) so the luma sum carries the lane.

// Each prepared-curve slot in the storage buffer is a fixed-stride f32 block:
//   [ len (as f32), x0, y0, t0, x1, y1, t1, ... up to CURVE_CAP knots ]
// len is small, so the f32 round-trip is exact. Stride = 1 + CURVE_CAP*3.
const CURVE_CAP: u32 = 32u;          // max knots per curve (CPU asserts the fit)
const SLOT_STRIDE: u32 = 1u + CURVE_CAP * 3u; // 97 floats per slot
const SLOT_PARAMETRIC: u32 = 0u;
const SLOT_LUMA: u32 = 1u;
const SLOT_R: u32 = 2u;
const SLOT_G: u32 = 3u;
const SLOT_B: u32 = 4u;

const REF_MAX: f32 = 4.0;
const LUMA_R: f32 = 0.2627;
const LUMA_G: f32 = 0.6780;
const LUMA_B: f32 = 0.0593;

struct Params {
    count: u32,             // number of RGBA pixels
    parametric_active: u32,  // 1 if the parametric curve runs
    luma_active: u32,        // 1 if tone_curve_luma runs
    per_channel_active: u32, // 1 if any per-channel curve runs
    mode: u32,               // 0 = PerChannel, 1 = RatioPreserving
    _pad0: u32,
    _pad1: u32,
    _pad2: u32,
};

@group(0) @binding(0) var<uniform> params: Params;
@group(0) @binding(1) var<storage, read> input_buf: array<vec4<f32>>;
@group(0) @binding(2) var<storage, read_write> output_buf: array<vec4<f32>>;
// 5 prepared-curve slots (parametric/luma/r/g/b), flat f32. Read-only storage
// (4-byte stride) — a uniform array would get a 16-byte per-element stride and
// silently misalign, the same trap auto_profile_curve's flat-curve buffer dodges.
@group(0) @binding(3) var<storage, read> curves: array<f32>;

fn slot_len(slot: u32) -> u32 {
    return u32(curves[slot * SLOT_STRIDE]);
}
fn knot_x(slot: u32, i: u32) -> f32 {
    return curves[slot * SLOT_STRIDE + 1u + i * 3u];
}
fn knot_y(slot: u32, i: u32) -> f32 {
    return curves[slot * SLOT_STRIDE + 1u + i * 3u + 1u];
}
fn knot_t(slot: u32, i: u32) -> f32 {
    return curves[slot * SLOT_STRIDE + 1u + i * 3u + 2u];
}

// Fritsch-Carlson monotone cubic Hermite at authoring x in [0, 1]. Mirrors
// `eval_monotonic_cubic`: endpoint clamps, then the bracketing-segment Hermite
// with the prepared per-knot tangents. `n >= 2` is guaranteed by the caller.
fn eval_monotonic_cubic(slot: u32, n: u32, x: f32) -> f32 {
    let x0 = knot_x(slot, 0u);
    let y0 = knot_y(slot, 0u);
    if (x <= x0) {
        return y0;
    }
    let xl = knot_x(slot, n - 1u);
    let yl = knot_y(slot, n - 1u);
    if (x >= xl) {
        return yl;
    }
    // Locate the segment bracketing x (first j with x in [x_j, x_{j+1}]).
    var i: u32 = 0u;
    for (var j: u32 = 0u; j < n - 1u; j = j + 1u) {
        if (x >= knot_x(slot, j) && x <= knot_x(slot, j + 1u)) {
            i = j;
            break;
        }
    }
    let xi = knot_x(slot, i);
    let xi1 = knot_x(slot, i + 1u);
    let yi = knot_y(slot, i);
    let yi1 = knot_y(slot, i + 1u);
    let ti = knot_t(slot, i);
    let ti1 = knot_t(slot, i + 1u);
    let dx = xi1 - xi;
    let t = (x - xi) / dx;
    let t2 = t * t;
    let t3 = t2 * t;
    let h00 = 2.0 * t3 - 3.0 * t2 + 1.0;
    let h10 = t3 - 2.0 * t2 + t;
    let h01 = -2.0 * t3 + 3.0 * t2;
    let h11 = t3 - t2;
    return h00 * yi + h10 * dx * ti + h01 * yi1 + h11 * dx * ti1;
}

fn my_tanh(x: f32) -> f32 {
    let clamped_x = clamp(x, -20.0, 20.0);
    let e2x = exp(2.0 * clamped_x);
    return (e2x - 1.0) / (e2x + 1.0);
}

// Evaluate a prepared curve at scene-linear v. Mirrors `eval_curve_scene_linear`:
// authoring [0, 1] maps to scene [0, REF_MAX]; degenerate-length paths preserved
// (len 0 -> v pass-through; len 1 -> constant knots[0].y * REF_MAX).
fn eval_curve_scene_linear(slot: u32, v: f32) -> f32 {
    let n = slot_len(slot);
    if (n < 2u) {
        if (n == 1u) {
            return knot_y(slot, 0u) * REF_MAX;
        }
        return v; // empty curve = identity / pass-through
    }
    let x_raw = v / REF_MAX;
    var x = x_raw;
    if (x_raw >= 0.98) {
        x = 0.98 + 0.02 * my_tanh((x_raw - 0.98) / 0.02);
    }
    x = clamp(x, 0.0, 1.0);
    let y_authoring = eval_monotonic_cubic(slot, n, x);
    return y_authoring * REF_MAX;
}

// Luma-coupled apply of one curve slot to the running pixel (hue-preserving).
// Mirrors `apply_parametric_luma_coupled` / `apply_point_curve_luma_coupled`:
// scale all three channels by Y_new / Y_old; skip when Y_old <= 0.
fn luma_coupled_curve(px: vec3<f32>, slot: u32) -> vec3<f32> {
    let y_old = LUMA_R * px.x + LUMA_G * px.y + LUMA_B * px.z;
    if (y_old <= 0.0) {
        return px;
    }
    let y_new = eval_curve_scene_linear(slot, y_old);
    let scale = y_new / y_old;
    return px * scale;
}

@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) gid: vec3<u32>, @builtin(num_workgroups) ng: vec3<u32>) {
    let i = gid.y * ng.x * 64u + gid.x;
    if (i >= params.count) {
        return;
    }
    let src = input_buf[i];
    var p = src.rgb;

    // 1) Parametric curve (luma-coupled).
    if (params.parametric_active == 1u) {
        p = luma_coupled_curve(p, SLOT_PARAMETRIC);
    }

    // 2) tone_curve_luma (luma-coupled).
    if (params.luma_active == 1u) {
        p = luma_coupled_curve(p, SLOT_LUMA);
    }

    // 3) Per-channel R/G/B, dispatched on mode.
    if (params.per_channel_active == 1u) {
        if (params.mode == 1u) {
            // RatioPreserving: fold the three curves through Rec.2020 luma to a
            // single scale. Identity curves run as empty-knot pass-through (len
            // 0 -> v) so the lane's unmodified luma rides the sum.
            let y_in = LUMA_R * p.x + LUMA_G * p.y + LUMA_B * p.z;
            if (y_in > 0.0) {
                let r_prime = eval_curve_scene_linear(SLOT_R, y_in);
                let g_prime = eval_curve_scene_linear(SLOT_G, y_in);
                let b_prime = eval_curve_scene_linear(SLOT_B, y_in);
                let y_out = LUMA_R * r_prime + LUMA_G * g_prime + LUMA_B * b_prime;
                let scale = y_out / y_in;
                p = p * scale;
            }
        } else {
            // PerChannel: each curve applies per-lane (hue shifts). Per-lane skip
            // on v <= 0. An identity (empty) curve is a no-op via len 0 -> v.
            if (p.x > 0.0) {
                p.x = eval_curve_scene_linear(SLOT_R, p.x);
            }
            if (p.y > 0.0) {
                p.y = eval_curve_scene_linear(SLOT_G, p.y);
            }
            if (p.z > 0.0) {
                p.z = eval_curve_scene_linear(SLOT_B, p.z);
            }
        }
    }

    output_buf[i] = vec4<f32>(p, src.a);
}
