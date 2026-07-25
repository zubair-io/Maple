// hsl.wgsl — scene-linear 8-band HSL stage (#1112, tone/zoom design § 10.4).
//
// Scene-linear Oklab, positioned after saturation / before clarity. Eight
// ACR-aligned hue bands; weights are normalized per-pixel (partition of unity
// despite non-uniform band spacing). Hard C < C0 early-return for neutral-axis
// stability; smoothstep(C0, 2·C0, C) chroma gate above threshold.
//
// Compiled with `compile_with_matrices` so the generated `mul_*` Oklab round-trip
// helpers are available (same concat pattern as vibrance / saturation).
//
// Bind layout: uniform @0 (Params), src storage @1, dst storage @2 — 2 storage
// buffers, under the ≤4/stage project budget.
//
// All 24 slider-derived values (hue_rad / sat_delta / lum_shift) are carried as
// arrays in the Params uniform (not storage buffers) — they fit within WebGPU's
// guaranteed 64 KiB uniform limit.

// ── Params (repr(C) mirror of the Rust `HslGpuParams` struct) ─────────────────
//
// WebGPU uniform address space requires array<f32, N> elements to be aligned to
// 16 bytes (vec4 stride). We therefore pack each 8-element band array as two
// vec4<f32> values (bands 0–3 and 4–7). The Rust struct mirrors this layout
// exactly with [[f32; 4]; 2] fields so bytemuck::bytes_of transmits correctly.

struct Params {
    // Per-band hue rotation in radians: hue_slider/100 · HSL_HUE_MAX_RAD.
    // bands 0-3 (Red, Orange, Yellow, Green) then bands 4-7 (Aqua, Blue, Purple, Magenta).
    hue_rad_0: vec4<f32>,
    hue_rad_1: vec4<f32>,
    // Per-band saturation DELTA: sat_slider/100 (not the scale; scale = 1 + delta).
    sat_delta_0: vec4<f32>,
    sat_delta_1: vec4<f32>,
    // Per-band luminance shift: lum_slider/100.
    lum_shift_0: vec4<f32>,
    lum_shift_1: vec4<f32>,
    // Per-band black & white luminance weight: gray_mixer_slider/100 (#276).
    // Read only when `bw_active` is set.
    bw_mix_0: vec4<f32>,
    bw_mix_1: vec4<f32>,
    // Chroma gate lower threshold (raw-core's CHROMA_GATE_C0 = 0.05).
    chroma_gate_c0: f32,
    // Number of RGBA pixels in this dispatch.
    count: u32,
    // 1 when ALL 24 sliders are at default — mirrors raw-core's
    // `HslParams::is_identity` per-pixel early-return (`apply_pixel` returns the
    // input bit-exactly). Required since the #1733/#1748 gamut soft-knee port:
    // without it, an identity-params dispatch (the UNGATED composition layer
    // runs every pass) would gamut-compress pixels that arrive already outside
    // Rec.2020, where the CPU stage is a pure passthrough.
    is_identity: u32,
    // 1 when black & white conversion is armed (#276). Takes over the whole
    // kernel: the hue/sat/lum arrays are ignored, the gray mixer drives L,
    // and every pixel leaves with zero Oklab chroma. Mirrors raw-core's
    // `HslParams::bw_active`, which likewise forces `is_identity` off.
    bw_active: u32,
};

@group(0) @binding(0) var<uniform> params: Params;
@group(0) @binding(1) var<storage, read> input_buf: array<vec4<f32>>;
@group(0) @binding(2) var<storage, read_write> output_buf: array<vec4<f32>>;

// ── Band centers (radians, same constant as raw-core's HUE_CENTERS_DEG) ───────
//
// ACR-aligned Oklab hue centers for the 8 bands (Red..Magenta), converted
// to radians. These match HUE_CENTERS_DEG in src/stages/hsl.rs exactly.
const CENTERS: array<f32, 8> = array<f32, 8>(
    0.506145483,  // Red   (29.0°)
    0.959931089,  // Orange (55.0°)
    1.919862177,  // Yellow (110.0°)
    2.530727415,  // Green  (145.0°)
    3.403392041,  // Aqua   (195.0°)
    4.363323130,  // Blue   (250.0°)
    4.974188368,  // Purple (285.0°)
    5.724986869,  // Magenta(328.0°)
);

// Half-width for the raised-cosine band weights (67.5° in radians).
const HALF_WIDTH: f32 = 1.178097245; // 67.5° = 67.5 * PI / 180

const PI: f32 = 3.141592653589793;
const TWO_PI: f32 = 6.283185307179586;

// ── Helpers ───────────────────────────────────────────────────────────────────

// Sign-preserving cube root (same helper as vibrance/saturation kernels).
fn cbrt_signed(x: f32) -> f32 {
    return sign(x) * pow(abs(x), 1.0 / 3.0);
}

// Scene-linear Rec.2020 → Oklab (mirrors raw_core::color::oklab).
fn rec2020_to_oklab(rgb: vec3<f32>) -> vec3<f32> {
    let srgb = mul_rec2020_to_srgb(rgb);
    let lms = mul_srgb_to_lms(srgb);
    let lms_cube = vec3<f32>(cbrt_signed(lms.x), cbrt_signed(lms.y), cbrt_signed(lms.z));
    return mul_lms_to_lab(lms_cube);
}

// Oklab → scene-linear Rec.2020 (mirrors raw_core::color::oklab).
fn oklab_to_rec2020(lab: vec3<f32>) -> vec3<f32> {
    let lms_cube = mul_lab_to_lms(lab);
    let lms = lms_cube * lms_cube * lms_cube;
    let srgb = mul_lms_to_srgb(lms);
    return mul_srgb_to_rec2020(srgb);
}

// Circular angular distance in [0, π] (radians), wrapping correctly.
fn circular_delta(h: f32, center: f32) -> f32 {
    var d = abs(h - center) % TWO_PI;
    if (d > PI) {
        d = TWO_PI - d;
    }
    return d;
}

// Raised-cosine weight: (1 + cos(π·δ/hw))/2 for δ < hw, else 0.
fn raised_cosine(delta: f32) -> f32 {
    if (delta >= HALF_WIDTH) {
        return 0.0;
    }
    let t = delta / HALF_WIDTH;
    return 0.5 * (1.0 + cos(PI * t));
}

// GLSL-compatible smoothstep.
fn smoothstep_fn(e0: f32, e1: f32, x: f32) -> f32 {
    let t = clamp((x - e0) / (e1 - e0), 0.0, 1.0);
    return t * t * (3.0 - 2.0 * t);
}

// ── Gamut soft-knee (#1733 / #1748, ported from raw_core::stages::hsl) ────────
//
// Mirrors HSL_GAMUT_EPS / HSL_GAMUT_KNEE_FRACTION / HSL_GAMUT_BISECT_ITERS and
// the `hsl_soft_compress` / `hsl_bisect_gamut_hull` fns in
// raw-core/src/stages/hsl.rs verbatim. Same shape as the saturation / vibrance
// kernels' knee; unlike those there is NO `.max(c_floor)` — hue rotation can
// land the pixel on a NARROWER part of the hull than the input hue, and a floor
// at the input chroma would re-emit the negative channel the bisection just
// solved for (see the raw-core comment).

const HSL_GAMUT_EPS: f32 = 1e-5;
const HSL_GAMUT_KNEE_FRACTION: f32 = 0.8;
const HSL_GAMUT_BISECT_ITERS: i32 = 24;

// Lower-bound-only gamut predicate: every Rec.2020 channel >= -HSL_GAMUT_EPS.
// Scene-linear values above 1 are legal and must pass (no upper bound).
fn hsl_min_channel_in_gamut(rgb: vec3<f32>) -> bool {
    let min_c = min(rgb.x, min(rgb.y, rgb.z));
    return min_c >= -HSL_GAMUT_EPS;
}

// Reinhard-style smooth compression — raw-core's `hsl_soft_compress` verbatim,
// including both early returns.
fn hsl_soft_compress(c_target: f32, c_hull: f32) -> f32 {
    let c_thresh = HSL_GAMUT_KNEE_FRACTION * c_hull;
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
// Rec.2020 projection has all channels >= -HSL_GAMUT_EPS. Mirrors raw-core's
// `hsl_bisect_gamut_hull` (same iteration count, same `lo` returned).
fn hsl_bisect_gamut_hull(l: f32, a_hat: f32, b_hat: f32, c_high: f32) -> f32 {
    var lo: f32 = 0.0;
    var hi: f32 = c_high;
    for (var iter: i32 = 0; iter < HSL_GAMUT_BISECT_ITERS; iter = iter + 1) {
        let mid = 0.5 * (lo + hi);
        let rgb = oklab_to_rec2020(vec3<f32>(l, a_hat * mid, b_hat * mid));
        if (hsl_min_channel_in_gamut(rgb)) {
            lo = mid;
        } else {
            hi = mid;
        }
    }
    return lo;
}

// ── Black & white conversion (#276) ───────────────────────────────────────────
//
// Line-for-line mirror of raw-core's `stages::hsl::bw_apply_pixel`: same band
// partition and chroma gate as the colour path, but the eight mixer weights
// drive L only and the output chroma is zero for EVERY pixel (the ticket's
// "saturation forced to 0"). No gamut work is needed — an Oklab colour with
// a = b = 0 maps to a neutral Rec.2020 triple and `1 + delta_mix` is bounded
// to [0, 2] by the ±100 slider range.

fn bw_pixel(rgb: vec3<f32>) -> vec3<f32> {
    let lab = rec2020_to_oklab(rgb);
    let l = lab.x;
    let a = lab.y;
    let b = lab.z;
    let c = sqrt(a * a + b * b);
    let c0 = params.chroma_gate_c0;

    var delta_mix = 0.0;
    // Below the gate the hue angle is meaningless — no band may claim this
    // pixel. It keeps its L and loses its (negligible) chroma.
    if (c >= c0) {
        let chroma_gate = smoothstep_fn(c0, 2.0 * c0, c);

        var hue = atan2(b, a);
        if (hue < 0.0) {
            hue = hue + TWO_PI;
        }

        var w: array<f32, 8>;
        var w_sum = 0.0;
        for (var band = 0u; band < 8u; band = band + 1u) {
            w[band] = raised_cosine(circular_delta(hue, CENTERS[band]));
            w_sum = w_sum + w[band];
        }

        if (w_sum >= 1e-6) {
            var bw_mix: array<f32, 8>;
            bw_mix[0] = params.bw_mix_0.x; bw_mix[1] = params.bw_mix_0.y;
            bw_mix[2] = params.bw_mix_0.z; bw_mix[3] = params.bw_mix_0.w;
            bw_mix[4] = params.bw_mix_1.x; bw_mix[5] = params.bw_mix_1.y;
            bw_mix[6] = params.bw_mix_1.z; bw_mix[7] = params.bw_mix_1.w;

            let w_norm_scale = chroma_gate / w_sum;
            for (var band = 0u; band < 8u; band = band + 1u) {
                if (w[band] < 1e-6) {
                    continue;
                }
                delta_mix = delta_mix + bw_mix[band] * w[band] * w_norm_scale;
            }
        }
    }

    return oklab_to_rec2020(vec3<f32>(l * (1.0 + delta_mix), 0.0, 0.0));
}

// ── Main kernel ───────────────────────────────────────────────────────────────

@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) gid: vec3<u32>, @builtin(num_workgroups) ng: vec3<u32>) {
    let i = gid.y * ng.x * 64u + gid.x;
    if (i >= params.count) {
        return;
    }

    let p = input_buf[i];
    let rgb = p.rgb;

    // All-defaults: bit-exact passthrough (raw-core's `p.is_identity` return).
    if (params.is_identity != 0u) {
        output_buf[i] = p;
        return;
    }

    // Black & white takes over the whole stage (#276) — mirrors the
    // `p.bw_active` branch at the top of raw-core's `apply_pixel`.
    if (params.bw_active != 0u) {
        output_buf[i] = vec4<f32>(bw_pixel(rgb), p.a);
        return;
    }

    // Convert to Oklab.
    let lab = rec2020_to_oklab(rgb);
    let l0 = lab.x;
    let a0 = lab.y;
    let b0 = lab.z;

    // Chroma magnitude.
    let c = sqrt(a0 * a0 + b0 * b0);

    // Hard early-return for near-neutrals (C < C0): bit-identical no-op.
    let c0 = params.chroma_gate_c0;
    if (c < c0) {
        output_buf[i] = p;
        return;
    }

    // Chroma gate: smoothstep(C0, 2·C0, C) — smooth onset above threshold.
    let chroma_gate = smoothstep_fn(c0, 2.0 * c0, c);

    // Oklab hue angle in [0, 2π).
    var hue = atan2(b0, a0);
    if (hue < 0.0) {
        hue = hue + TWO_PI;
    }

    // Normalized unit-direction vector (hue axis).
    let a_hat = a0 / c;
    let b_hat = b0 / c;

    // Compute raw raised-cosine weights for all 8 bands, then normalize.
    var w: array<f32, 8>;
    var w_sum = 0.0;
    for (var band = 0u; band < 8u; band = band + 1u) {
        let delta = circular_delta(hue, CENTERS[band]);
        w[band] = raised_cosine(delta);
        w_sum = w_sum + w[band];
    }

    // Coverage guard (should never fire with hw=67.5° and these centers,
    // but be defensive).
    if (w_sum < 1e-6) {
        output_buf[i] = p;
        return;
    }

    let w_norm_scale = chroma_gate / w_sum;

    // Unpack vec4-packed band arrays into indexable local arrays.
    var hue_rad: array<f32, 8>;
    hue_rad[0] = params.hue_rad_0.x; hue_rad[1] = params.hue_rad_0.y;
    hue_rad[2] = params.hue_rad_0.z; hue_rad[3] = params.hue_rad_0.w;
    hue_rad[4] = params.hue_rad_1.x; hue_rad[5] = params.hue_rad_1.y;
    hue_rad[6] = params.hue_rad_1.z; hue_rad[7] = params.hue_rad_1.w;

    var sat_delta: array<f32, 8>;
    sat_delta[0] = params.sat_delta_0.x; sat_delta[1] = params.sat_delta_0.y;
    sat_delta[2] = params.sat_delta_0.z; sat_delta[3] = params.sat_delta_0.w;
    sat_delta[4] = params.sat_delta_1.x; sat_delta[5] = params.sat_delta_1.y;
    sat_delta[6] = params.sat_delta_1.z; sat_delta[7] = params.sat_delta_1.w;

    var lum_shift: array<f32, 8>;
    lum_shift[0] = params.lum_shift_0.x; lum_shift[1] = params.lum_shift_0.y;
    lum_shift[2] = params.lum_shift_0.z; lum_shift[3] = params.lum_shift_0.w;
    lum_shift[4] = params.lum_shift_1.x; lum_shift[5] = params.lum_shift_1.y;
    lum_shift[6] = params.lum_shift_1.z; lum_shift[7] = params.lum_shift_1.w;

    // Accumulate per-band contributions.
    var delta_hue_rad = 0.0;
    var delta_sat = 0.0;  // additive chroma scale delta
    var delta_lum = 0.0;

    for (var band = 0u; band < 8u; band = band + 1u) {
        if (w[band] < 1e-6) {
            continue;
        }
        let ww = w[band] * w_norm_scale;
        delta_hue_rad = delta_hue_rad + hue_rad[band] * ww;
        delta_sat = delta_sat + sat_delta[band] * ww;
        delta_lum = delta_lum + lum_shift[band] * ww;
    }

    // Apply luminance (scale L — hue-preserving). Mirrors the raw-core branch
    // exactly: the multiply only runs when |delta_lum| > 1e-6 (a sub-threshold
    // accumulated shift must leave L bit-identical, as the CPU stage does).
    var l_new = l0;
    if (abs(delta_lum) > 1e-6) {
        l_new = l0 * (1.0 + delta_lum);
    }

    // Apply saturation (scale chroma). The floor at 0 is an Oklab-chroma floor
    // only — full gamut protection is the soft-knee below (#1733 / #1748).
    let c_target = max(c * (1.0 + delta_sat), 0.0);

    // Apply hue rotation on the post-saturation chroma, so the gamut check
    // below sees the same final hue the pixel will actually land at.
    let cos_dh = cos(delta_hue_rad);
    let sin_dh = sin(delta_hue_rad);
    let rot_a_hat = a_hat * cos_dh - b_hat * sin_dh;
    let rot_b_hat = a_hat * sin_dh + b_hat * cos_dh;

    // Fast path: rotated + scaled target stays in gamut. NOTE: hue rotation
    // alone can leave gamut (the hull is not hue-invariant), so there is no
    // `c_target <= c` shortcut that skips this check (#1748).
    let a_fast = c_target * rot_a_hat;
    let b_fast = c_target * rot_b_hat;
    let rgb_target = oklab_to_rec2020(vec3<f32>(l_new, a_fast, b_fast));
    if (hsl_min_channel_in_gamut(rgb_target)) {
        output_buf[i] = vec4<f32>(rgb_target, p.a);
        return;
    }

    // Bisect for the hull chroma along the POST-ROTATION hue ray, then
    // Reinhard-soft-compress into it. No `.max(c_floor)` — see the knee's
    // module comment above.
    let c_hull = hsl_bisect_gamut_hull(l_new, rot_a_hat, rot_b_hat, c_target);
    let c_out = hsl_soft_compress(c_target, c_hull);
    let out_rgb = oklab_to_rec2020(vec3<f32>(l_new, rot_a_hat * c_out, rot_b_hat * c_out));
    output_buf[i] = vec4<f32>(out_rgb, p.a);
}
