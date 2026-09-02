// display_tone_curve.wgsl — display-referred (post-AgX) tone curves, a
// WGSL port of `raw_core::stages::display_tone_curve::apply` (#2232).
//
// Adobe's `crs:ToneCurvePV2012*` — a DIFFERENT quantity from
// `tone_curves.wgsl`'s scene-linear family: this kernel runs POST-AgX, on a
// buffer already bounded to `[0, 1]` by AgX's own Oklab gamut compression,
// and evaluates directly on that domain (no REF_MAX rescale). The runtime
// data is the PREPARED curves (sorted/deduped/clamped knots + the
// Fritsch-Carlson tangents), computed CPU-side once and uploaded to a
// storage buffer — same shape as `tone_curves.wgsl`, just 4 slots instead
// of 5 and no scene-linear rescale.
//
// Per pixel: master curve evaluated identically on R, G, B (NOT
// luma-coupled — matches Adobe Camera Raw's own point-curve behaviour),
// then each channel's own curve on top of that result.
//
// PARITY-CRITICAL invariants (mirrored verbatim from prep.rs):
//   * eval_curve_unit: len 0 -> v (pass-through); len 1 -> constant
//     knots[0].y; else clamp v into [0, 1] then evaluate the monotonic
//     cubic Hermite — no REF_MAX scaling in either direction.
//   * eval_monotonic_cubic: x<=knots[0].x -> knots[0].y; x>=knots[last].x ->
//     knots[last].y; else cubic Hermite on the bracketing segment with the
//     prepared tangents.

// Each prepared-curve slot in the storage buffer is a fixed-stride f32 block:
//   [ len (as f32), x0, y0, t0, x1, y1, t1, ... up to CURVE_CAP knots ]
// len is small, so the f32 round-trip is exact. Stride = 1 + CURVE_CAP*3.
const CURVE_CAP: u32 = 32u;          // max knots per curve (CPU asserts the fit)
const SLOT_STRIDE: u32 = 1u + CURVE_CAP * 3u; // 97 floats per slot
const SLOT_MASTER: u32 = 0u;
const SLOT_R: u32 = 1u;
const SLOT_G: u32 = 2u;
const SLOT_B: u32 = 3u;

struct Params {
    count: u32,             // number of RGBA pixels
    _pad0: u32,
    _pad1: u32,
    _pad2: u32,
};

@group(0) @binding(0) var<uniform> params: Params;
@group(0) @binding(1) var<storage, read> input_buf: array<vec4<f32>>;
@group(0) @binding(2) var<storage, read_write> output_buf: array<vec4<f32>>;
// 4 prepared-curve slots (master/r/g/b), flat f32. Read-only storage
// (4-byte stride) — a uniform array would get a 16-byte per-element stride
// and silently misalign, the same trap `tone_curves.wgsl` dodges.
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

// Fritsch-Carlson monotone cubic Hermite at x in [0, 1]. Mirrors
// `eval_monotonic_cubic`: endpoint clamps, then the bracketing-segment
// Hermite with the prepared per-knot tangents. `n >= 2` is guaranteed by
// the caller.
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

// Evaluate a prepared curve at a value already in [0, 1]. Mirrors
// `eval_curve_unit`: len 0 -> v (pass-through); len 1 -> constant
// knots[0].y; else clamp then evaluate.
fn eval_curve_unit(slot: u32, v: f32) -> f32 {
    let n = slot_len(slot);
    if (n < 2u) {
        if (n == 1u) {
            return knot_y(slot, 0u);
        }
        return v;
    }
    return eval_monotonic_cubic(slot, n, clamp(v, 0.0, 1.0));
}

@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) gid: vec3<u32>, @builtin(num_workgroups) ng: vec3<u32>) {
    let i = gid.y * ng.x * 64u + gid.x;
    if (i >= params.count) {
        return;
    }
    let src = input_buf[i];
    let r = eval_curve_unit(SLOT_R, eval_curve_unit(SLOT_MASTER, src.r));
    let g = eval_curve_unit(SLOT_G, eval_curve_unit(SLOT_MASTER, src.g));
    let b = eval_curve_unit(SLOT_B, eval_curve_unit(SLOT_MASTER, src.b));
    output_buf[i] = vec4<f32>(r, g, b, src.a);
}
