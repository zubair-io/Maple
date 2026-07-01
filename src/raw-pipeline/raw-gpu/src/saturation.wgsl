// saturation.wgsl — Oklab chroma-scale saturation with gamut-aware
// soft-compression (raw-core spec § 02; raw_core::stages::saturation::apply / #269).
//
// A P2 scene-linear stage (epic #925 / #990). Unlike vibrance, saturation has no
// low-chroma boost and no skin-tone protection: it scales ALL chroma uniformly
// by `1 + saturation/100`. The trickier half is the gamut handling — at positive
// saturation a uniform chroma scale can push a Rec.2020 channel negative, so the
// chroma is soft-compressed back along the SAME Oklab hue line toward the
// per-pixel gamut hull (found by a 24-iteration bisection), with a Reinhard knee.
//
// Parity oracle: raw-gpu::apply_saturation (CPU), a line-for-line copy of
// raw_core::stages::saturation::apply_pixel. Parity gate < 1e-4 vs that oracle
// AND vs the real `raw_core::stages::saturation::apply` (see saturation/tests.rs).
//
// ## How the color matrices get here (same as vibrance)
//
// WGSL has no `#include`. The generated color-matrix module
// (`generated/color_matrices.wgsl`) is concatenated AHEAD of this source at
// shader-module creation (see `context.rs::saturation_pipeline`). It defines the
// rec2020↔Oklab `mul_*` helpers used below. The round-trip here is the FULL
// rec2020 Oklab pair (NOT the sRGB-only pair display_encode uses), matching
// raw_core::color::oklab::{rec2020_to_oklab, oklab_to_rec2020} exactly.
//
// ## Scene-linear vs display-cube: two ways this differs from display_encode
//
// display_encode.wgsl shares the 24-iter bisection shape, but it works in the
// display UNIT CUBE; saturation works in scene-linear (UNBOUNDED above 1):
//   1. The gamut predicate is LOWER-BOUND ONLY: `min(r,g,b) >= -GAMUT_EPS`. We
//      must NOT clamp the upper edge (HDR scene values > 1 are legal and pass).
//   2. The in-gamut FAST PATH returns the chroma-scaled, ROUND-TRIPPED pixel
//      (`rgb_target`), NOT the untouched input — only the near-neutral guard is
//      a bit-exact passthrough.
//
// Stage-local constants are inlined here (precedent: scene_tone inlines
// LUMA_REC2020, display_encode inlines 24 / 1e-5) — they are not codegen'd
// color matrices, so no generated module carries them.

struct Params {
    scale: f32,  // 1.0 + saturation / 100.0
    count: u32,  // number of RGBA pixels
    _pad0: u32,
    _pad1: u32,
};

@group(0) @binding(0) var<uniform> params: Params;
@group(0) @binding(1) var<storage, read> input_buf: array<vec4<f32>>;
@group(0) @binding(2) var<storage, read_write> output_buf: array<vec4<f32>>;

// ── Stage-local constants (verbatim from raw_core::stages::saturation) ──────
// GAMUT_KNEE_FRACTION: fraction of the hull chroma where the soft knee starts.
// GAMUT_BISECT_ITERS: bisection iteration count (24 → relative precision < 1e-6).
// GAMUT_EPS: per-channel lower tolerance for the "in gamut" predicate.
const GAMUT_KNEE_FRACTION: f32 = 0.8;
const GAMUT_BISECT_ITERS: i32 = 12;
const GAMUT_EPS: f32 = 1e-5;

// Sign-preserving cube root (WGSL has no `cbrt`; `pow(x, 1/3)` is NaN for x<0).
// Mirrors Rust's `f32::cbrt`. Same helper as the vibrance kernel.
fn cbrt_signed(x: f32) -> f32 {
    return sign(x) * pow(abs(x), 1.0 / 3.0);
}

// Scene-linear Rec.2020 D65 → Oklab. Mirrors raw_core::color::oklab::rec2020_to_oklab.
fn rec2020_to_oklab(rgb: vec3<f32>) -> vec3<f32> {
    let srgb = mul_rec2020_to_srgb(rgb);
    let lms = mul_srgb_to_lms(srgb);
    let lms_cube = vec3<f32>(cbrt_signed(lms.x), cbrt_signed(lms.y), cbrt_signed(lms.z));
    return mul_lms_to_lab(lms_cube);
}

// Oklab → scene-linear Rec.2020 D65. Mirrors raw_core::color::oklab::oklab_to_rec2020.
fn oklab_to_rec2020(lab: vec3<f32>) -> vec3<f32> {
    let lms_cube = mul_lab_to_lms(lab);
    let lms = lms_cube * lms_cube * lms_cube; // cube — sign-preserving by construction
    return mul_lms_to_srgb_then_rec2020(lms);
}

// Compose the two inverse matrices the Rust path applies after the cube:
//   srgb = M1_LMS_TO_SRGB · lms;  rec2020 = M_SRGB_TO_REC2020 · srgb
// (kept as two dot-product matmuls so it is byte-identical to the Rust
// `m1_inv.mul_vec` → `m_srgb_to_rec2020.mul_vec` sequence — NOT a pre-multiplied
// single matrix, whose different float reduction order could drift parity).
fn mul_lms_to_srgb_then_rec2020(lms: vec3<f32>) -> vec3<f32> {
    let srgb = mul_lms_to_srgb(lms);
    return mul_srgb_to_rec2020(srgb);
}

// Lower-bound-only gamut predicate: every Rec.2020 channel ≥ -GAMUT_EPS. NOTE:
// unlike display_encode's `in_unit_box`, there is NO upper bound — scene-linear
// values above 1 are legal and must pass. Mirrors the `min_c >= -GAMUT_EPS`
// test in raw-core's bisection + fast path.
fn min_channel_in_gamut(rgb: vec3<f32>) -> bool {
    let min_c = min(rgb.x, min(rgb.y, rgb.z));
    return min_c >= -GAMUT_EPS;
}

// Reinhard-style smooth compression along the chroma scalar. Below
// `c_thresh = GAMUT_KNEE_FRACTION * c_hull` it is the identity; above the knee it
// asymptotes smoothly to `c_hull`. Mirrors raw_core::stages::saturation::soft_compress
// verbatim, INCLUDING both early returns.
fn soft_compress(c_target: f32, c_hull: f32) -> f32 {
    let c_thresh = GAMUT_KNEE_FRACTION * c_hull;
    if (c_target <= c_thresh) {
        return c_target;
    }
    let d = c_target - c_thresh;
    let d_max = c_hull - c_thresh;
    if (d_max <= 0.0) {
        return c_hull;
    }
    return c_thresh + d_max * (d / (d + d_max));
}

// Bisect along the (L, a_hat, b_hat) Oklab ray for the largest chroma whose
// Rec.2020 projection has all channels ≥ -GAMUT_EPS. Assumes the caller verified
// `c_high` is out of gamut and `c_low = 0` (a neutral grey) is in gamut. Mirrors
// raw_core::stages::saturation::bisect_gamut_hull — same 24 iterations, same
// `lo` (in-gamut tracker) returned.
fn bisect_gamut_hull(l: f32, a_hat: f32, b_hat: f32, c_high: f32) -> f32 {
    var lo: f32 = 0.0;
    var hi: f32 = c_high;
    for (var iter: i32 = 0; iter < GAMUT_BISECT_ITERS; iter = iter + 1) {
        let mid = 0.5 * (lo + hi);
        let rgb = oklab_to_rec2020(vec3<f32>(l, a_hat * mid, b_hat * mid));
        if (min_channel_in_gamut(rgb)) {
            lo = mid;
        } else {
            hi = mid;
        }
    }
    return lo;
}

@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) gid: vec3<u32>, @builtin(num_workgroups) ng: vec3<u32>) {
    let i = gid.y * ng.x * 64u + gid.x;
    if (i >= params.count) {
        return;
    }
    let px = input_buf[i];
    let rgb = px.rgb;
    let scale = params.scale;

    let lab = rec2020_to_oklab(rgb);
    let l = lab.x;
    let a = lab.y;
    let b = lab.z;

    // Near-neutral pixel: chroma is zero in any direction, scaling is a no-op
    // (and the hue unit vector below would be ill-defined / NaN). Pass the
    // ORIGINAL rgb through bit-exact. Mirrors the Rust `return rgb`.
    //
    // FAN-OUT NOTE: this is the NaN-safety guard the step-1 analysis flagged —
    // at exact zero chroma `a/c_in` and `b/c_in` are 0/0 = NaN, so a true
    // neutral that skipped this branch would propagate NaN through the whole
    // scale + round-trip. Same guard vibrance keeps; keep it.
    let c_in = sqrt(a * a + b * b);
    if (c_in < 1e-6) {
        output_buf[i] = px;
        return;
    }

    // Target chroma after uniform Oklab scaling. Hue (atan2(b, a)) is unchanged
    // by construction. Mirror the EXACT float sequence (a_hat * c_target, NOT
    // a * scale) so the round-trip is byte-identical to the Rust path.
    let c_target = c_in * scale;
    let a_hat = a / c_in;
    let b_hat = b / c_in;

    // Desaturation (scale ≤ 1): gamut never tightens — moving toward neutral
    // can't push any channel further negative than the original. Return the
    // round-tripped scaled pixel directly (NOT a bit-exact passthrough). Mirrors
    // the Rust `if scale <= 1.0` early return.
    if (scale <= 1.0) {
        let out_rgb = oklab_to_rec2020(vec3<f32>(l, a_hat * c_target, b_hat * c_target));
        output_buf[i] = vec4<f32>(out_rgb, px.a);
        return;
    }

    // Fast path: the scaled target is already in gamut. Most +saturation pixels
    // are far enough from the hull that this wins. Return the ROUND-TRIPPED
    // target (`rgb_target`), NOT the untouched input — only the neutral guard
    // above is a bit-exact passthrough. Mirrors the Rust fast path.
    let rgb_target = oklab_to_rec2020(vec3<f32>(l, a_hat * c_target, b_hat * c_target));
    if (min_channel_in_gamut(rgb_target)) {
        output_buf[i] = vec4<f32>(rgb_target, px.a);
        return;
    }

    // Out of gamut: bisect for the hull chroma along this (L, hue) ray, then
    // soft-compress the target toward it. `c_floor = c_in` enforces "+saturation
    // never reduces chroma below the input" — if the input was already past the
    // hull (e.g. vibrance pushed it out before saturation), soft_compress(..) ≤
    // c_hull < c_in and the `max` pins c_out to c_in. Mirrors the Rust tail.
    let c_hull = bisect_gamut_hull(l, a_hat, b_hat, c_target);
    let c_floor = c_in;
    let c_out = max(soft_compress(c_target, c_hull), c_floor);
    let out_rgb = oklab_to_rec2020(vec3<f32>(l, a_hat * c_out, b_hat * c_out));
    output_buf[i] = vec4<f32>(out_rgb, px.a);
}
