// agx.wgsl — AgX view transform (scene-linear Rec.2020 -> display-linear
// Rec.2020). A P2 view-transform stage (epic #925 / #990).
//
// Line-for-line WGSL port of `raw_core::view::agx::apply` -> `agx_pixel`
// (post-#435: inset -> log encode -> ratio-preserving sigmoid -> outset ->
// Oklab hue-preserving gamut compression). Mirrors the GLSL shader at
// src/web/projects/maple-common/src/lib/webgl/shaders/agx-view-transform.ts,
// but matches raw-core's runtime path exactly by sampling the SAME baked
// 512-entry LUT (agx_lut.bin) raw-core's `sample_lut` reads, uploaded to a
// storage buffer — NOT the closed-form sigmoid the GLSL recomputes. That
// keeps the GPU on the same numerical path the parity oracle uses (closed-
// form vs LUT differ ~1e-4, which the ratio scale + outset would amplify
// past the gate).
//
// Two `#include`-free concats are prepended at module creation (WGSL has no
// `#include`):
//   - generated/color_matrices.wgsl: mul_rec2020_to_srgb / mul_srgb_to_lms /
//     mul_lms_to_lab + inverses (the Oklab round-trip for gamut compress).
//   - generated/agx_coeffs.wgsl: AGX_MIN_EV / AGX_MAX_EV / AGX_MID_GRAY /
//     AGX_MID_NORM / AGX_LUT_SIZE + mul_agx_inset / mul_agx_outset.
//
// PARITY-CRITICAL invariants (mirrored verbatim from raw-core agx.rs /
// agx_hue_restoration.rs):
//   * log_encode: floor = MID_GRAY * 2^MIN_EV; clamp log2 to [MIN_EV, MAX_EV].
//   * sample_lut: linear interp; idx = clamp(x,0,1) * (SIZE-1); i1 capped.
//   * contrast: slope = 1 + (contrast/100)*0.5; pivot the normalized-log
//     value around AGX_MID_NORM BEFORE sampling the LUT.
//   * ratio sigmoid: n = max(R,G,B); if n <= 1e-6 (RATIO_FLOOR) sigmoid the
//     floor once and return that neutral; else scale RGB by sigmoid(n)/n.
//   * oklab_gamut_compress: in-gamut (EPS_HI=1+1e-5, EPS_LO=-1e-5) returns a
//     clamp; else 24-iter (a,b) bisection at constant L, trailing clamp.

struct Params {
    count: u32,      // number of RGBA pixels
    contrast: f32,   // -100..+100; 0 = reference Sobotka sigmoid
    _pad0: u32,
    _pad1: u32,
};

@group(0) @binding(0) var<uniform> params: Params;
@group(0) @binding(1) var<storage, read> input_buf: array<vec4<f32>>;
@group(0) @binding(2) var<storage, read_write> output_buf: array<vec4<f32>>;
// The baked AgX sigmoid LUT (agx_lut.bin: AGX_LUT_SIZE x f32). Read-only
// storage (4-byte stride) — a uniform array<f32> would get a 16-byte
// per-element stride and silently misalign.
@group(0) @binding(3) var<storage, read> agx_lut: array<f32>;

// Deep-shadow floor for the ratio scale (raw-core RATIO_FLOOR). Below this
// the ratio sn/n would diverge; treat as a pure neutral.
const AGX_RATIO_FLOOR: f32 = 1.0e-6;

// Sign-preserving cube root (WGSL has no `cbrt`; pow(x,1/3) is NaN for x<0).
// Mirrors Rust's f32::cbrt — same helper as the display_encode kernel.
fn cbrt_signed(x: f32) -> f32 {
    return sign(x) * pow(abs(x), 1.0 / 3.0);
}

// Per-channel log2 encode + normalize to [0, 1]. Mirror of raw-core
// `log_encode` (Sobotka open_domain_to_normalized_log2): pinned at the toe
// for non-positive inputs via the `max(x, floor)`.
fn agx_log_encode(channel: f32) -> f32 {
    let floor_v = AGX_MID_GRAY * exp2(AGX_MIN_EV);
    let clamped = max(channel, floor_v);
    let log_v = clamp(log2(clamped / AGX_MID_GRAY), AGX_MIN_EV, AGX_MAX_EV);
    return (log_v - AGX_MIN_EV) / (AGX_MAX_EV - AGX_MIN_EV);
}

// Sample the baked AgX sigmoid LUT with linear interpolation at normalized-
// log position `x`. Mirrors raw-core `sample_lut` index math EXACTLY.
fn agx_sample_lut(x: f32) -> f32 {
    let xc = clamp(x, 0.0, 1.0);
    let size_m1 = f32(AGX_LUT_SIZE - 1u);
    let idx = xc * size_m1;
    let i0 = u32(floor(idx));
    let i1 = min(i0 + 1u, AGX_LUT_SIZE - 1u);
    let f = idx - floor(idx);
    return agx_lut[i0] * (1.0 - f) + agx_lut[i1] * f;
}

// The 1D AgX sigmoid in normalized-log space: log-encode, apply contrast
// modulation around AGX_MID_NORM, then LUT-sample. Mirrors raw-core's
// `sigmoid_curve` closure (with `slope` precomputed by the caller).
fn agx_sigmoid_curve(x: f32, slope: f32) -> f32 {
    let norm = agx_log_encode(x);
    let modulated = AGX_MID_NORM + (norm - AGX_MID_NORM) * slope;
    return agx_sample_lut(modulated);
}

// Ratio-preserving sigmoid: sigmoid the max channel, scale RGB by the same
// factor (hue invariant). Mirrors raw-core `norm_sigmoid_ratio`.
fn agx_ratio_sigmoid(inset: vec3<f32>, slope: f32) -> vec3<f32> {
    let n = max(max(inset.x, inset.y), inset.z);
    if (n <= AGX_RATIO_FLOOR) {
        // Deep shadow: sigmoid the floor once, return the neutral.
        let v = agx_sigmoid_curve(AGX_RATIO_FLOOR, slope);
        return vec3<f32>(v, v, v);
    }
    let sn = agx_sigmoid_curve(n, slope);
    let ratio = sn / n;
    return inset * ratio;
}

// ── Oklab round-trip (rec2020 pair) for gamut compression ────────────────
// raw-core agx_hue_restoration uses `rec2020_to_oklab` / `oklab_to_rec2020`
// (the FULL pair, including the inner rec2020<->srgb step) — unlike the
// display_encode kernel's sRGB-only pair. Built from the generated
// color_matrices.wgsl helpers.
fn rec2020_to_oklab(rgb: vec3<f32>) -> vec3<f32> {
    let lin_srgb = mul_rec2020_to_srgb(rgb);
    let lms = mul_srgb_to_lms(lin_srgb);
    let lms_cube = vec3<f32>(cbrt_signed(lms.x), cbrt_signed(lms.y), cbrt_signed(lms.z));
    return mul_lms_to_lab(lms_cube);
}

fn oklab_to_rec2020(lab: vec3<f32>) -> vec3<f32> {
    let lms_cube = mul_lab_to_lms(lab);
    let lms = lms_cube * lms_cube * lms_cube; // cube — sign-preserving
    let lin_srgb = mul_lms_to_srgb(lms);
    return mul_srgb_to_rec2020(lin_srgb);
}

// In-gamut predicate with the fp-edge epsilon. Mirrors raw-core's
// `in_unit_box`: EPS_HI = 1 + 1e-5, EPS_LO = -1e-5.
fn in_unit_box(rgb: vec3<f32>) -> bool {
    let eps_hi = 1.0 + 1e-5;
    let eps_lo = -1e-5;
    return rgb.x >= eps_lo && rgb.x <= eps_hi
        && rgb.y >= eps_lo && rgb.y <= eps_hi
        && rgb.z >= eps_lo && rgb.z <= eps_hi;
}

// Largest in-gamut chroma scale at constant L and hue (bracket + 24-iter
// bisection). Mirrors raw_core::color::oklab_gamut::hull_scale (Rec.2020 pair).
fn hull_scale_rec2020(l: f32, a: f32, b: f32) -> f32 {
    var lo: f32;
    var hi: f32;
    if (in_unit_box(oklab_to_rec2020(vec3<f32>(l, a, b)))) {
        var s: f32 = 1.0;
        var steps: i32 = 0;
        loop {
            if (!(in_unit_box(oklab_to_rec2020(vec3<f32>(l, a * s, b * s))) && steps < 16)) {
                break;
            }
            s = s * 2.0;
            steps = steps + 1;
        }
        if (in_unit_box(oklab_to_rec2020(vec3<f32>(l, a * s, b * s)))) {
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
        if (in_unit_box(oklab_to_rec2020(vec3<f32>(l, a * mid, b * mid)))) {
            lo = mid;
        } else {
            hi = mid;
        }
    }
    return lo;
}

// Soft, hue-preserving gamut compression toward [0, 1]^3 via Oklab (a, b)
// scaling at constant L. Mirrors raw-core `oklab_gamut_compress` ->
// `compress_to_unit_cube_oklab` (#1621): chroma below THRESHOLD*hull passes
// through; chroma beyond rolls off with a Reinhard soft-knee (no clip plateau).
fn oklab_gamut_compress(rgb: vec3<f32>) -> vec3<f32> {
    let chroma_floor = 1e-5;
    let threshold = 0.8; // raw-core COMPRESS_THRESHOLD

    let lab = rec2020_to_oklab(rgb);
    let l = lab.x;
    let a = lab.y;
    let b = lab.z;
    let c_in = sqrt(a * a + b * b);
    if (c_in <= chroma_floor) {
        return clamp(rgb, vec3<f32>(0.0), vec3<f32>(1.0));
    }
    if (in_unit_box(oklab_to_rec2020(vec3<f32>(l, a / threshold, b / threshold)))) {
        return rgb;
    }
    let s_hull = hull_scale_rec2020(l, a, b);
    let hull = c_in * s_hull;
    if (!(hull == hull) || hull > 3.4e38 || hull <= chroma_floor) {
        return clamp(oklab_to_rec2020(vec3<f32>(l, a * max(s_hull, 0.0), b * max(s_hull, 0.0))),
                     vec3<f32>(0.0), vec3<f32>(1.0));
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
    return clamp(oklab_to_rec2020(vec3<f32>(l, a * s, b * s)), vec3<f32>(0.0), vec3<f32>(1.0));
}

@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) gid: vec3<u32>, @builtin(num_workgroups) ng: vec3<u32>) {
    let i = gid.y * ng.x * 64u + gid.x;
    if (i >= params.count) {
        return;
    }
    let px = input_buf[i];

    // slope = 1 + (contrast/100)*0.5. At +100 -> 1.5x, at -100 -> 0.5x.
    let slope = 1.0 + (params.contrast / 100.0) * 0.5;

    // 1) Inset matrix: Rec.2020 -> AgX-Base-Rec.2020. No pre-clamp — the
    //    ratio-preserving sigmoid handles deep shadow uniformly.
    let inset = mul_agx_inset(px.rgb);

    // 2) Ratio-preserving sigmoid (hue invariant).
    let sig = agx_ratio_sigmoid(inset, slope);

    // 3) Outset matrix back to Rec.2020 primaries.
    let outc = mul_agx_outset(sig);

    // 4) Hue-preserving Oklab gamut compression to [0, 1]^3.
    let display = oklab_gamut_compress(outc);

    output_buf[i] = vec4<f32>(display, px.a);
}
