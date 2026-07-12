// display_encode.wgsl — Rec.2020 → display-primary encode with hue-preserving
// gamut compression (raw-core spec; view::encode::rec2020_to_display / #438 / #1337).
//
// A P2 view-transform stage (epic #925 / #990). This is the f32 → f32
// display-encode step ONLY: the linear-Rec.2020 → linear-display matrix, plus a
// hue-preserving Oklab soft gamut compression at constant `L` (#1621 — a
// Reinhard soft-knee that rolls chroma off below the hull rather than
// hard-clipping onto it). It does NOT fold in the sRGB gamma encode or the
// dither/quantize-to-u8 step — those are format-changing output steps, not
// scene/display f32 chain passes.
//
// Two target primaries are supported via the `target_primaries` uniform (0 = sRGB,
// 1 = Display P3). The OETF (IEC 61966-2-1 / 2.4-gamma) is identical for both;
// only the primaries matrix differs. The default (0 = sRGB) preserves the
// pre-#1337 output bit-exactly.
//
// Mirrors `raw_core::view::encode::rec2020_to_display`. Each path rotates into
// the target primaries FIRST, then gamut-compresses against THAT target's hull
// (#1921 — compressing to the sRGB hull before the P3 rotation used to cap P3
// output at sRGB gamut):
//   [sRGB]  srgb = M_REC2020_TO_SRGB · rgb
//           out  = compress_to_unit_cube_srgb(srgb)   // sRGB-hull Oklab compress
//   [P3]    p3   = M_REC2020_TO_P3 · rgb
//           out  = compress_to_unit_cube_p3(p3)        // P3-hull Oklab compress
//
// PARITY-CRITICAL invariants (mirrored verbatim from raw-core):
//
// * Below-knee FAST-PATH: when scaling the chroma by 1/THRESHOLD still lands in
//   the unit box (i.e. chroma <= THRESHOLD*hull), the input is returned
//   UNMODIFIED — byte-identical, NOT an Oklab round-trip (a round-trip would
//   drift ~1e-7 and the encode's byte-identity contract gates exactly this
//   branch). The unit-box predicate uses EPS_HI = 1 + 1e-5, EPS_LO = -1e-5.
// * Knee/out-of-gamut path: find the hull via bracket + 24-iteration bisection
//   (`hull_scale`), then apply the Reinhard soft-knee to chroma in
//   [THRESHOLD*hull, inf) -> [THRESHOLD*hull, hull), and a trailing clamp to
//   [0, 1] (Oklab round-trips can drift a few ULPs past the edge).
//
// ## Oklab is primaries-independent — one LMS transform, two working spaces
//
// Oklab is defined via a fixed linear-sRGB → LMS transform, so a color's Oklab
// coordinate is the same whichever RGB space represents it. The sRGB path feeds
// its linear-sRGB triple straight into that transform; the P3 path first rotates
// its linear-P3 triple to linear sRGB (mul_p3_to_srgb) before the same transform
// (and rotates back with mul_srgb_to_p3 on the way out). The compression's
// unit-box test therefore targets the sRGB hull for the sRGB path and the P3
// hull for the P3 path — which is the whole point of #1921.
// Built from the generated `color_matrices.wgsl` helpers:
//   srgb_linear_to_oklab: mul_srgb_to_lms → cbrt → mul_lms_to_lab
//   oklab_to_srgb_linear: mul_lab_to_lms → cube(c*c*c) → mul_lms_to_srgb
//   p3_linear_to_oklab:   mul_p3_to_srgb → srgb_linear_to_oklab
//   oklab_to_p3_linear:   oklab_to_srgb_linear → mul_srgb_to_p3
// Cube is `c*c*c` (sign-preserving by construction), never `pow`.

struct Params {
    count: u32,          // number of RGBA pixels
    target_primaries: u32, // 0 = sRGB (default), 1 = Display P3 (#1337)
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

// Display-working-space → Oklab. `is_p3 == false` treats the triple as linear
// sRGB (the sRGB-hull path); `is_p3 == true` rotates linear P3 → linear sRGB
// (mul_p3_to_srgb) first, so the compression targets the P3 hull (#1921). Oklab
// itself is primaries-independent — one LMS transform, selected working space.
// Mirrors raw_core::color::oklab::{srgb_linear_to_oklab, p3_linear_to_oklab}.
fn display_to_oklab(rgb: vec3<f32>, is_p3: bool) -> vec3<f32> {
    if (is_p3) {
        return srgb_linear_to_oklab(mul_p3_to_srgb(rgb));
    }
    return srgb_linear_to_oklab(rgb);
}

// Oklab → display working space (inverse of `display_to_oklab`). `is_p3 == true`
// rotates the linear-sRGB result into P3 primaries (mul_srgb_to_p3). Mirrors
// raw_core::color::oklab::{oklab_to_srgb_linear, oklab_to_p3_linear}.
fn oklab_to_display(lab: vec3<f32>, is_p3: bool) -> vec3<f32> {
    if (is_p3) {
        return mul_srgb_to_p3(oklab_to_srgb_linear(lab));
    }
    return oklab_to_srgb_linear(lab);
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

fn clamp_unit_scrub_non_finite(v: f32) -> f32 {
    if (v < 3.4e38 && v > -3.4e38) {
        return clamp(v, 0.0, 1.0);
    }
    return 0.0;
}

fn clamp_unit_scrub_non_finite_vec3(v: vec3<f32>) -> vec3<f32> {
    return vec3<f32>(
        clamp_unit_scrub_non_finite(v.x),
        clamp_unit_scrub_non_finite(v.y),
        clamp_unit_scrub_non_finite(v.z)
    );
}

// Largest in-gamut chroma scale at constant L and hue (bracket + 24-iter
// bisection). Mirrors raw_core::color::oklab_gamut::hull_scale. `is_p3` selects
// the target hull (sRGB vs P3, #1921) via `oklab_to_display`.
fn hull_scale_display(l: f32, a: f32, b: f32, is_p3: bool) -> f32 {
    var lo: f32;
    var hi: f32;
    if (in_unit_box(oklab_to_display(vec3<f32>(l, a, b), is_p3))) {
        // In gamut at the input chroma — grow until we exit the box.
        var s: f32 = 1.0;
        var steps: i32 = 0;
        loop {
            if (!(in_unit_box(oklab_to_display(vec3<f32>(l, a * s, b * s), is_p3)) && steps < 16)) {
                break;
            }
            s = s * 2.0;
            steps = steps + 1;
        }
        if (in_unit_box(oklab_to_display(vec3<f32>(l, a * s, b * s), is_p3))) {
            return s;
        }
        lo = s * 0.5;
        hi = s;
    } else {
        lo = 0.0;
        hi = 1.0;
    }
    for (var iter: i32 = 0; iter < 24; iter = iter + 1) {
        let mid = 0.5 * (lo + hi);
        if (in_unit_box(oklab_to_display(vec3<f32>(l, a * mid, b * mid), is_p3))) {
            lo = mid;
        } else {
            hi = mid;
        }
    }
    return lo;
}

// Soft, hue-preserving gamut compression toward [0, 1]^3 via Oklab (a, b)
// scaling at constant L. Mirrors raw_core::color::oklab_gamut::compress_to_unit_cube_oklab
// (#1621). `is_p3` selects the working space / target hull (#1921): the unit-box
// test is performed in the SAME space the input `rgb` is in (linear sRGB when
// `is_p3 == false`, linear P3 when `is_p3 == true`). Chroma below THRESHOLD*hull
// passes through; chroma beyond is rolled off with a Reinhard soft-knee (strictly
// increasing, bounded by the hull — no clip plateau).
fn compress_to_unit_cube_display(rgb: vec3<f32>, is_p3: bool) -> vec3<f32> {
    let chroma_floor = 1e-5;
    let threshold = 0.8; // raw-core COMPRESS_THRESHOLD

    let lab = display_to_oklab(rgb, is_p3);
    let l = lab.x;
    let a = lab.y;
    let b = lab.z;
    let c_in = sqrt(a * a + b * b);
    if (c_in <= chroma_floor) {
        return clamp_unit_scrub_non_finite_vec3(rgb);
    }
    // Knee probe: below the knee -> untouched (byte-identity + skip bisection).
    if (in_unit_box(oklab_to_display(vec3<f32>(l, a / threshold, b / threshold), is_p3))) {
        return rgb;
    }
    let s_hull = hull_scale_display(l, a, b, is_p3);
    let hull = c_in * s_hull;
    if (!(hull == hull) || hull > 3.4e38 || hull <= chroma_floor) {
        // Degenerate (extreme L / non-finite) — hard projection fallback.
        return clamp_unit_scrub_non_finite_vec3(oklab_to_display(vec3<f32>(l, a * max(s_hull, 0.0), b * max(s_hull, 0.0)), is_p3));
    }
    let knee = threshold * hull;
    var c_out: f32;
    if (c_in <= knee) {
        c_out = c_in;
    } else {
        let x = (c_in - knee) / (hull - knee);
        c_out = knee + (hull - knee) * (x / (1.0 + x));
    }
    let s = c_out / c_in;
    return clamp_unit_scrub_non_finite_vec3(oklab_to_display(vec3<f32>(l, a * s, b * s), is_p3));
}

// Note: mul_rec2020_to_srgb, mul_rec2020_to_p3, mul_srgb_to_p3, and mul_p3_to_srgb
// are provided by the generated color_matrices.wgsl module, concatenated ahead of
// this file at pipeline creation. All are single-sourced from
// raw-core/src/color/matrices.rs via the codegen emitter (#1337 / #1921).
//
// Pipeline order (mirrors raw_core::view::encode::rec2020_to_display). Each path
// rotates into the target primaries FIRST, then gamut-compresses against THAT
// target's hull (#1921):
//   [sRGB]  Rec.2020 → linear sRGB (mul_rec2020_to_srgb), compress to sRGB hull
//   [P3]    Rec.2020 → linear P3   (mul_rec2020_to_p3),   compress to P3 hull
//
// Compressing to the sRGB hull before the P3 rotation (the pre-#1921 order)
// capped P3 output at sRGB gamut. Compressing in the target space instead lets
// P3 output carry saturation the sRGB gamut cannot express.

@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) gid: vec3<u32>, @builtin(num_workgroups) ng: vec3<u32>) {
    let i = gid.y * ng.x * 64u + gid.x;
    if (i >= params.count) {
        return;
    }
    let px = input_buf[i];
    // target_primaries is a uniform — the compiler turns this into a uniform
    // branch with no warp divergence; both arms are NOT evaluated per pixel
    // (unlike WGSL select() which evaluates both arguments eagerly).
    var out_rgb: vec3<f32>;
    if (params.target_primaries == 1u) {
        // Rec.2020 → linear P3, then Oklab gamut compress against the P3 hull.
        out_rgb = compress_to_unit_cube_display(mul_rec2020_to_p3(px.rgb), true);
    } else {
        // Rec.2020 → linear sRGB, then Oklab gamut compress against the sRGB hull.
        out_rgb = compress_to_unit_cube_display(mul_rec2020_to_srgb(px.rgb), false);
    }
    output_buf[i] = vec4<f32>(out_rgb, px.a);
}
