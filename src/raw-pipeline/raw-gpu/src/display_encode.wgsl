// display_encode.wgsl — Rec.2020 → sRGB display encode with hue-preserving
// gamut compression (raw-core spec; view::encode::rec2020_to_srgb / #438).
//
// A P2 view-transform stage (epic #925 / #990). This is the f32 → f32
// display-encode step ONLY: the linear-Rec.2020 → linear-sRGB matrix, plus an
// Oklab `(a, b)` bisection at constant `L` that compresses any post-matrix
// triple leaving `[0, 1]^3` back into gamut while keeping hue invariant. It does
// NOT fold in the sRGB gamma encode or the dither/quantize-to-u8 step — those
// are format-changing output steps, not scene/display f32 chain passes.
//
// Mirrors `raw_core::view::encode::rec2020_to_srgb`:
//   srgb = M_REC2020_TO_SRGB · rgb
//   out  = compress_to_unit_cube_oklab(srgb, srgb_linear_to_oklab, oklab_to_srgb_linear)
//
// PARITY-CRITICAL invariants (mirrored verbatim from raw-core):
//
// * In-gamut FAST-PATH: when the post-matrix triple is already inside the unit
//   box (with the fp-edge epsilon), it is returned UNMODIFIED — byte-identical,
//   NOT an Oklab round-trip (a round-trip would drift ~1e-7 and the encode's
//   byte-identity contract gates exactly this branch). The unit-box predicate
//   uses EPS_HI = 1 + 1e-5, EPS_LO = -1e-5.
// * Out-of-gamut path: 24-iteration binary search for the largest scale s in
//   [0, 1] such that `oklab_to_srgb_linear([L, s*a, s*b])` is in-gamut, then a
//   trailing clamp to [0, 1] (Oklab round-trips can drift a few ULPs past the
//   edge even when the bisection landed inside).
//
// ## sRGB-only Oklab pair (NOT the rec2020 pair)
//
// The matrix already lands the triple in linear sRGB, so the Oklab transforms
// here must NOT re-apply the inner rec2020→srgb step. We use the sRGB-only pair,
// built from the generated `color_matrices.wgsl` helpers (concatenated ahead of
// this source at module creation — WGSL has no `#include`):
//   srgb_linear_to_oklab: mul_srgb_to_lms → cbrt → mul_lms_to_lab
//   oklab_to_srgb_linear: mul_lab_to_lms → cube(c*c*c) → mul_lms_to_srgb
// Cube is `c*c*c` (sign-preserving by construction), never `pow`.

struct Params {
    count: u32,  // number of RGBA pixels
    _pad0: u32,
    _pad1: u32,
    _pad2: u32,
};

@group(0) @binding(0) var<uniform> params: Params;
@group(0) @binding(1) var<storage, read> input_buf: array<vec4<f32>>;
@group(0) @binding(2) var<storage, read_write> output_buf: array<vec4<f32>>;

// Sign-preserving cube root (WGSL has no `cbrt`; `pow(x, 1/3)` is NaN for x<0).
// Mirrors Rust's `f32::cbrt`. (Same helper as the vibrance kernel.)
fn cbrt_signed(x: f32) -> f32 {
    return sign(x) * pow(abs(x), 1.0 / 3.0);
}

// Linear sRGB D65 → Oklab. Mirrors raw_core::color::oklab::srgb_linear_to_oklab
// (NO inner rec2020 step). Uses the generated sRGB↔LMS↔Lab helpers.
fn srgb_linear_to_oklab(rgb: vec3<f32>) -> vec3<f32> {
    let lms = mul_srgb_to_lms(rgb);
    let lms_cube = vec3<f32>(cbrt_signed(lms.x), cbrt_signed(lms.y), cbrt_signed(lms.z));
    return mul_lms_to_lab(lms_cube);
}

// Oklab → linear sRGB D65. Mirrors raw_core::color::oklab::oklab_to_srgb_linear.
fn oklab_to_srgb_linear(lab: vec3<f32>) -> vec3<f32> {
    let lms_cube = mul_lab_to_lms(lab);
    let lms = lms_cube * lms_cube * lms_cube; // cube — sign-preserving
    return mul_lms_to_srgb(lms);
}

// In-gamut predicate with the fp-edge epsilon. Mirrors raw-core's `in_unit_box`:
// EPS_HI = 1 + 1e-5, EPS_LO = -1e-5.
fn in_unit_box(rgb: vec3<f32>) -> bool {
    let eps_hi = 1.0 + 1e-5;
    let eps_lo = -1e-5;
    return rgb.x >= eps_lo && rgb.x <= eps_hi
        && rgb.y >= eps_lo && rgb.y <= eps_hi
        && rgb.z >= eps_lo && rgb.z <= eps_hi;
}

// Hue-preserving compression toward [0, 1]^3 via Oklab (a, b) bisection at
// constant L. Mirrors raw_core::color::oklab_gamut::compress_to_unit_cube_oklab
// specialised to the sRGB-linear working space (the encode call site).
fn compress_to_unit_cube(rgb: vec3<f32>) -> vec3<f32> {
    // Byte-identity fast-path: in-gamut input is returned UNTOUCHED (no
    // round-trip). The trailing clamp below is deliberately NOT applied here.
    if (in_unit_box(rgb)) {
        return rgb;
    }
    let lab = srgb_linear_to_oklab(rgb);
    let l = lab.x;
    let a = lab.y;
    let b = lab.z;
    // 24-iteration binary search for the largest in-gamut scale s in [0, 1].
    var lo: f32 = 0.0;
    var hi: f32 = 1.0;
    for (var iter: i32 = 0; iter < 24; iter = iter + 1) {
        let mid = 0.5 * (lo + hi);
        let candidate = oklab_to_srgb_linear(vec3<f32>(l, a * mid, b * mid));
        if (in_unit_box(candidate)) {
            lo = mid;
        } else {
            hi = mid;
        }
    }
    let out = oklab_to_srgb_linear(vec3<f32>(l, a * lo, b * lo));
    // Tighten with the trailing clamp — Oklab round-trips can drift a few ULPs
    // past 0 or 1 even when the bisection landed inside.
    return clamp(out, vec3<f32>(0.0), vec3<f32>(1.0));
}

@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
    let i = gid.x;
    if (i >= params.count) {
        return;
    }
    let px = input_buf[i];
    let srgb = mul_rec2020_to_srgb(px.rgb);
    let out_rgb = compress_to_unit_cube(srgb);
    output_buf[i] = vec4<f32>(out_rgb, px.a);
}
