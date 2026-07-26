// local_adjustments.wgsl — GPU vector-mask rasterizer + local apply (#1698).
//
// Ports `raw_core::stages::local_adjustments::{apply, apply_pixel}` and
// `raw_core::stages::local_adjustments::mask::evaluate` to a single compute
// kernel. Before this, `local_adjustments` was the one scene-linear stage with
// no WGSL implementation at all, so on the GPU-live path — the shipping default
// on Apple and on WebGPU browsers since #925 — a mask produced no pixels
// whatsoever until the 150 ms CPU refine pass landed.
//
// ## One dispatch for the whole layer stack
//
// The Rust stage loops `for layer { for pixel { .. } }`, compositing each layer
// over the previous layer's output across the whole image before starting the
// next. Both `mask::evaluate` and `apply_pixel` are purely local — the weight
// depends only on the pixel's normalized coordinate, and the apply reads and
// writes exactly that one pixel — so running the layer loop INSIDE the pixel
// loop, in registers, produces the identical result. That collapses the stage
// to ONE dispatch regardless of layer count: no per-layer ping-pong, no extra
// scratch buffer, and the layer stack rides a single read-only storage buffer
// (`params @0` uniform + src/dst/layers = 3 storage buffers, under the
// 4-per-stage `downlevel_defaults()` ceiling from #925).
//
// ## Normalized coordinates
//
// Mask geometry is normalized `[0, 1]`, origin top-left, with `inv_w`/`inv_h`
// hoisted host-side by the SAME `1 / (dim - 1)` rule the Rust stage uses (and
// its `dim == 1` degenerate fallback of 0). That is why the kernel derives the
// pixel coordinate from `buf_width` + the tile origin the way vignette does:
// the mapping must be anchored to the FULL image, not to a sub-rectangle.
// Aspect ratio is deliberately NOT corrected — a "circular" radial mask on a
// 16:9 frame is an ellipse on screen, which is the convention the schema and
// the Rust evaluator already fixed.
//
// ## Parity oracle
//
// `raw_core::stages::local_adjustments::apply` itself, via the test-only
// raw-core dev-dep — no transcribed CPU twin to drift from it. See
// `local_adjustments/tests.rs`.
//
// ## How the color matrices get here
//
// WGSL has no `#include`. `generated/color_matrices.wgsl` is concatenated ahead
// of this source at module creation (see `context_pipelines.rs`), same as
// vibrance / saturation, supplying the row-major rec2020 <-> Oklab `mul_*`
// helpers. The CAT16 matrices are NOT codegen'd, so they are transcribed below
// and pinned against `raw_core::color::matrices` by the parity test.

struct Params {
    count: u32,        // number of RGBA pixels in the buffer
    layer_count: u32,  // number of Layer records in `layers`
    buf_width: u32,    // buffer row stride in pixels
    origin_x: u32,     // buffer's left edge in full-image pixels
    origin_y: u32,     // buffer's top edge in full-image pixels
    _pad0: u32,
    inv_w: f32,        // 1 / (full_width - 1), or 0 when full_width == 1
    inv_h: f32,        // 1 / (full_height - 1), or 0 when full_height == 1
};

// One serialized layer. Byte-for-byte the 24-float record
// `raw_core::types::local_adjustment::flat` writes; see that module for the
// slot map and for why presence is an explicit bitmask rather than a sentinel.
struct Layer {
    geom: vec4<f32>,   // p0.xy, p1.xy  (start/end, or center/radii)
    shape: vec4<f32>,  // feather, angle, kind, invert
    flags: vec4<f32>,  // presence bitmask, padding
    adj0: vec4<f32>,   // exposure, contrast, highlights, shadows
    adj1: vec4<f32>,   // whites, blacks, saturation, vibrance
    adj2: vec4<f32>,   // temperature, tint, padding
};

@group(0) @binding(0) var<uniform> params: Params;
@group(0) @binding(1) var<storage, read> input_buf: array<vec4<f32>>;
@group(0) @binding(2) var<storage, read_write> output_buf: array<vec4<f32>>;
@group(0) @binding(3) var<storage, read> layers: array<Layer>;

// `f32::EPSILON`, the degenerate-geometry threshold the Rust evaluator uses.
const F32_EPSILON: f32 = 1.1920929e-7;
const KIND_RADIAL: f32 = 1.0;

// Presence bits, in the field order of `adj0`/`adj1`/`adj2`.
const P_EXPOSURE: u32    = 1u;
const P_CONTRAST: u32    = 2u;
const P_HIGHLIGHTS: u32  = 4u;
const P_SHADOWS: u32     = 8u;
const P_WHITES: u32      = 16u;
const P_BLACKS: u32      = 32u;
const P_SATURATION: u32  = 64u;
const P_VIBRANCE: u32    = 128u;
const P_TEMPERATURE: u32 = 256u;
const P_TINT: u32        = 512u;

// ── Stage-local constants, verbatim from raw-core ─────────────────────────
// Rec.2020 luma weights (scene_tone_controls::LUMA_REC2020) and the
// shadows/highlights band constants the local apply reuses from that stage.
const LUMA_REC2020: vec3<f32> = vec3<f32>(0.2627, 0.6780, 0.0593);
const S_T1: f32 = 0.25;
const S_GAIN_EV: f32 = 1.5;
const H_W0: f32 = 0.25;
const H_W1: f32 = 1.0;
const H_GAIN_EV: f32 = 0.7;
// Oklab gamut handling, shared with the saturation / vibrance kernels.
const GAMUT_KNEE_FRACTION: f32 = 0.8;
const GAMUT_BISECT_ITERS: i32 = 24;
const GAMUT_EPS: f32 = 1e-5;
// White-balance constants (color::matrices + stages::white_balance).
const TINT_UV_SCALE: f32 = 1.0 / 3000.0;
const XYZ_D65: vec3<f32> = vec3<f32>(0.9504, 1.0000, 1.0888);

// A row-major 3x3, so every product below reproduces raw-core's
// `Matrix3::mul_vec` / `mul_mat` float sequence exactly. WGSL's own
// `mat3x3<f32>` is COLUMN-major and would silently transpose.
struct M3 { r0: vec3<f32>, r1: vec3<f32>, r2: vec3<f32> };

const CAT16: M3 = M3(
    vec3<f32>(0.401288, 0.650173, -0.051461),
    vec3<f32>(-0.250268, 1.204414, 0.045854),
    vec3<f32>(-0.002079, 0.048952, 0.953127),
);
// `CAT16.inverse()` evaluated in f32 by raw-core's `Matrix3::inverse` and
// transcribed; the parity test pins these against a fresh inverse.
const CAT16_INV: M3 = M3(
    vec3<f32>(1.8620679, -1.0112545, 0.14918676),
    vec3<f32>(0.38752654, 0.62144744, -0.008973984),
    vec3<f32>(-0.015841497, -0.034122933, 1.0499644),
);
const M_REC2020_TO_XYZ_D65: M3 = M3(
    vec3<f32>(0.6369580, 0.1446169, 0.1688810),
    vec3<f32>(0.2627002, 0.6779981, 0.0593017),
    vec3<f32>(0.0000000, 0.0280727, 1.0609851),
);
const M_XYZ_D65_TO_REC2020: M3 = M3(
    vec3<f32>(1.7166512, -0.3556708, -0.2533663),
    vec3<f32>(-0.6666844, 1.6164812, 0.0157685),
    vec3<f32>(0.0176399, -0.0427706, 0.9421031),
);

fn m3_mul_vec(m: M3, v: vec3<f32>) -> vec3<f32> {
    return vec3<f32>(
        m.r0.x * v.x + m.r0.y * v.y + m.r0.z * v.z,
        m.r1.x * v.x + m.r1.y * v.y + m.r1.z * v.z,
        m.r2.x * v.x + m.r2.y * v.y + m.r2.z * v.z,
    );
}

// `out[i][j] = a[i][0]*b[0][j] + a[i][1]*b[1][j] + a[i][2]*b[2][j]` — the term
// order of `Matrix3::mul_mat`.
fn m3_mul_mat(a: M3, b: M3) -> M3 {
    return M3(
        a.r0.x * b.r0 + a.r0.y * b.r1 + a.r0.z * b.r2,
        a.r1.x * b.r0 + a.r1.y * b.r1 + a.r1.z * b.r2,
        a.r2.x * b.r0 + a.r2.y * b.r1 + a.r2.z * b.r2,
    );
}

// ── Mask evaluation (raw_core::stages::local_adjustments::mask) ───────────

fn linear_weight(start: vec2<f32>, end_pt: vec2<f32>, feather_in: f32, p: vec2<f32>) -> f32 {
    let d = end_pt - start;
    let len_sq = d.x * d.x + d.y * d.y;
    if (len_sq <= F32_EPSILON) {
        // Degenerate start == end: no gradient rather than a divide by zero.
        return 0.0;
    }
    let t = ((p.x - start.x) * d.x + (p.y - start.y) * d.y) / len_sq;
    let feather = clamp(feather_in, 0.0, 1.0);
    if (feather <= F32_EPSILON) {
        return select(1.0, 0.0, t < 0.5);   // hard step at t = 0.5
    }
    let lo = 0.5 - feather * 0.5;
    let hi = 0.5 + feather * 0.5;
    return smoothstep(lo, hi, t);
}

fn radial_weight(
    center: vec2<f32>,
    radii: vec2<f32>,
    angle: f32,
    feather_in: f32,
    p: vec2<f32>,
) -> f32 {
    if (abs(radii.x) <= F32_EPSILON || abs(radii.y) <= F32_EPSILON) {
        return 0.0;
    }
    // Inverse-rotate the sample into the ellipse's local frame.
    let cos_a = cos(angle);
    let sin_a = sin(angle);
    let dv = p - center;
    let lx = cos_a * dv.x + sin_a * dv.y;
    let ly = -sin_a * dv.x + cos_a * dv.y;
    let rx = lx / radii.x;
    let ry = ly / radii.y;
    let d = sqrt(rx * rx + ry * ry);   // d == 1 on the boundary
    let feather = clamp(feather_in, 0.0, 1.0);
    if (feather <= F32_EPSILON) {
        return select(0.0, 1.0, d <= 1.0);
    }
    // Falloff from d = 1 - feather (w = 1) out to d = 1 (w = 0).
    return 1.0 - smoothstep(1.0 - feather, 1.0, d);
}

fn mask_weight(layer: Layer, p: vec2<f32>) -> f32 {
    let feather = layer.shape.x;
    if (layer.shape.z == KIND_RADIAL) {
        let w = radial_weight(layer.geom.xy, layer.geom.zw, layer.shape.y, feather, p);
        if (layer.shape.w != 0.0) {
            return 1.0 - w;
        }
        return w;
    }
    return linear_weight(layer.geom.xy, layer.geom.zw, feather, p);
}

// ── Oklab helpers (identical to the saturation / vibrance kernels) ────────

fn cbrt_signed(x: f32) -> f32 {
    return sign(x) * pow(abs(x), 1.0 / 3.0);
}

fn rec2020_to_oklab(rgb: vec3<f32>) -> vec3<f32> {
    let srgb = mul_rec2020_to_srgb(rgb);
    let lms = mul_srgb_to_lms(srgb);
    let lms_cube = vec3<f32>(cbrt_signed(lms.x), cbrt_signed(lms.y), cbrt_signed(lms.z));
    return mul_lms_to_lab(lms_cube);
}

fn oklab_to_rec2020(lab: vec3<f32>) -> vec3<f32> {
    let lms_cube = mul_lab_to_lms(lab);
    let lms = lms_cube * lms_cube * lms_cube;
    return mul_srgb_to_rec2020(mul_lms_to_srgb(lms));
}

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

fn bisect_gamut_hull(l: f32, a_hat: f32, b_hat: f32, c_high: f32) -> f32 {
    var lo: f32 = 0.0;
    var hi: f32 = c_high;
    for (var iter: i32 = 0; iter < GAMUT_BISECT_ITERS; iter = iter + 1) {
        let mid = 0.5 * (lo + hi);
        let rgb = oklab_to_rec2020(vec3<f32>(l, a_hat * mid, b_hat * mid));
        if (min(rgb.r, min(rgb.g, rgb.b)) >= -GAMUT_EPS) {
            lo = mid;
        } else {
            hi = mid;
        }
    }
    return lo;
}

// raw_core::stages::saturation::apply_pixel.
fn saturation_pixel(rgb: vec3<f32>, scale: f32) -> vec3<f32> {
    let lab = rec2020_to_oklab(rgb);
    let l = lab.x;
    let a = lab.y;
    let b = lab.z;
    let c_in = sqrt(a * a + b * b);
    if (c_in < 1e-6) {
        return rgb;   // near-neutral: bit-exact passthrough, and NaN-safe
    }
    let c_target = c_in * scale;
    let a_hat = a / c_in;
    let b_hat = b / c_in;
    if (scale <= 1.0) {
        return oklab_to_rec2020(vec3<f32>(l, a_hat * c_target, b_hat * c_target));
    }
    let rgb_target = oklab_to_rec2020(vec3<f32>(l, a_hat * c_target, b_hat * c_target));
    if (min(rgb_target.r, min(rgb_target.g, rgb_target.b)) >= -GAMUT_EPS) {
        return rgb_target;
    }
    let c_hull = bisect_gamut_hull(l, a_hat, b_hat, c_target);
    let c_out = max(soft_compress(c_target, c_hull), c_in);
    return oklab_to_rec2020(vec3<f32>(l, a_hat * c_out, b_hat * c_out));
}

// raw_core::stages::vibrance::apply_pixel.
fn vibrance_pixel(rgb: vec3<f32>, amount: f32) -> vec3<f32> {
    let lab = rec2020_to_oklab(rgb);
    let l = lab.x;
    let a = lab.y;
    let b = lab.z;
    let chroma = sqrt(a * a + b * b);
    if (!(chroma >= 1e-6) || chroma > 3.4e38) {
        return rgb;
    }
    let hue_deg = atan2(b, a) * 180.0 / 3.14159265358979323846;
    let skin_mask = smoothstep(15.0, 22.0, hue_deg) * (1.0 - smoothstep(35.0, 42.0, hue_deg));
    let low_chroma_factor = 1.0 - min(chroma / 0.3, 1.0);
    let scale = 1.0 + low_chroma_factor * amount * (1.0 - skin_mask * 0.6);

    let c_target = chroma * scale;
    let a_hat = a / chroma;
    let b_hat = b / chroma;
    if (scale <= 1.0) {
        return oklab_to_rec2020(vec3<f32>(l, a_hat * c_target, b_hat * c_target));
    }
    let rgb_target = oklab_to_rec2020(vec3<f32>(l, a_hat * c_target, b_hat * c_target));
    if (min(rgb_target.r, min(rgb_target.g, rgb_target.b)) >= -GAMUT_EPS) {
        return rgb_target;
    }
    let c_hull = bisect_gamut_hull(l, a_hat, b_hat, c_target);
    let c_out = max(soft_compress(c_target, c_hull), chroma);
    return oklab_to_rec2020(vec3<f32>(l, a_hat * c_out, b_hat * c_out));
}

// ── CAT16 white balance (raw_core::stages::white_balance) ─────────────────
//
// The local temperature/tint are RELATIVE offsets from the D65 anchor and the
// mask weight scales them, so the adaptation matrix is a function of the
// PER-PIXEL weight and cannot be hoisted to the host the way the global
// `WhiteBalancePass` hoists its one matrix. The whole derivation therefore
// runs per pixel, in the same order as the Rust chain, and only for layers
// that actually set one of the two controls.

fn cct_to_xy(cct: f32) -> vec2<f32> {
    let t = clamp(cct, 2000.0, 25000.0);
    var x: f32;
    if (t <= 4000.0) {
        x = 0.179910 + 0.8776956e3 / t - 0.2343589e6 / (t * t) - 0.2661239e9 / (t * t * t);
    } else {
        x = 0.240390 + 0.2226347e3 / t + 2.1070379e6 / (t * t) - 3.0258469e9 / (t * t * t);
    }
    let y = -3.000 * x * x + 2.870 * x - 0.275;
    return vec2<f32>(x, y);
}

// CIE xy -> CIE 1960 UCS (u, v). NOT the 1976 (u', v') formulae.
fn xy_to_uv(p: vec2<f32>) -> vec2<f32> {
    let denom = -2.0 * p.x + 12.0 * p.y + 3.0;
    return vec2<f32>(4.0 * p.x / denom, 6.0 * p.y / denom);
}

fn uv_to_xy(uv: vec2<f32>) -> vec2<f32> {
    let denom = 2.0 * uv.x - 8.0 * uv.y + 4.0;
    return vec2<f32>(3.0 * uv.x / denom, 2.0 * uv.y / denom);
}

// Unit tangent to the locus at `cct`, by central difference at +/- 50 K with
// the CENTRE clamped first (clamping each endpoint independently reverses the
// axis outside [2000, 25000]).
fn locus_tangent_uv(cct: f32) -> vec2<f32> {
    let center = clamp(cct, 2000.0, 25000.0);
    let up = xy_to_uv(cct_to_xy(min(center + 50.0, 25000.0)));
    let um = xy_to_uv(cct_to_xy(max(center - 50.0, 2000.0)));
    let d = up - um;
    let len = max(sqrt(d.x * d.x + d.y * d.y), 1e-10);
    return d / len;
}

// `wb_cat16_matrix(temperature, tint)`. The tint axis is the locus
// perpendicular with a POSITIVE v-component (CAT16: tint+ = greener source).
fn wb_cat16_matrix(temperature: f32, tint: f32) -> M3 {
    let xy = cct_to_xy(temperature);
    let tangent = locus_tangent_uv(temperature);
    let perp = vec2<f32>(tangent.y, -tangent.x);
    let uv = xy_to_uv(xy) + tint * TINT_UV_SCALE * perp;
    let sxy = uv_to_xy(uv);

    // xy_to_xyz(sx, sy, 1.0)
    let xyz_source = vec3<f32>(
        sxy.x / sxy.y,
        1.0,
        (1.0 - sxy.x - sxy.y) / sxy.y,
    );
    let lms_src = m3_mul_vec(CAT16, xyz_source);
    let lms_dst = m3_mul_vec(CAT16, XYZ_D65);
    let s = vec3<f32>(
        lms_dst.x / max(lms_src.x, 1e-6),
        lms_dst.y / max(lms_src.y, 1e-6),
        lms_dst.z / max(lms_src.z, 1e-6),
    );
    let scale = M3(
        vec3<f32>(s.x, 0.0, 0.0),
        vec3<f32>(0.0, s.y, 0.0),
        vec3<f32>(0.0, 0.0, s.z),
    );
    // Same left-to-right composition the Rust chain builds:
    // ((((M_xyz_to_rec2020 . CAT16_inv) . scale) . CAT16) . M_rec2020_to_xyz).
    let a = m3_mul_mat(M_XYZ_D65_TO_REC2020, CAT16_INV);
    let b = m3_mul_mat(a, scale);
    let c = m3_mul_mat(b, CAT16);
    return m3_mul_mat(c, M_REC2020_TO_XYZ_D65);
}

// ── Per-pixel apply (raw_core::stages::local_adjustments::apply_pixel) ────

fn luma(p: vec3<f32>) -> f32 {
    return LUMA_REC2020.x * p.x + LUMA_REC2020.y * p.y + LUMA_REC2020.z * p.z;
}

fn shadows_mult(y: f32, s_amount: f32) -> f32 {
    let t = 1.0 - smoothstep(0.0, S_T1, y);
    return 1.0 + (exp2(S_GAIN_EV * s_amount) - 1.0) * (t * t);
}

fn highlights_mult(y: f32, h_amount: f32, h_denom: f32, h_expand: f32) -> f32 {
    let g = exp2(-H_GAIN_EV * h_amount * smoothstep(H_W0, H_W1, y));
    if (y > 1.0) {
        var y_new: f32;
        if (h_amount >= 0.0) {
            y_new = 1.0 + (y - 1.0) / h_denom;
        } else {
            y_new = 1.0 + (y - 1.0) * h_expand;
        }
        return (y_new / y) * g;
    }
    return g;
}

fn apply_pixel(rgb: vec3<f32>, layer: Layer, w: f32) -> vec3<f32> {
    var p = rgb;
    let present = u32(layer.flags.x);

    // 1. Exposure — additive in EV, multiplicative in linear.
    if ((present & P_EXPOSURE) != 0u) {
        p = p * exp2(w * layer.adj0.x);
    }

    // 2. Temperature / tint — CAT16, with the mask weight scaling the
    //    source-white delta away from the 6500 K D65 anchor.
    if ((present & (P_TEMPERATURE | P_TINT)) != 0u) {
        let t_delta = select(0.0, layer.adj2.x, (present & P_TEMPERATURE) != 0u);
        let tint_delta = select(0.0, layer.adj2.y, (present & P_TINT) != 0u);
        p = m3_mul_vec(wb_cat16_matrix(6500.0 + w * t_delta, w * tint_delta), p);
    }

    // 3. Contrast — scene-linear power curve pivoted at 0.18 grey.
    if ((present & P_CONTRAST) != 0u) {
        let gamma = exp2(w * layer.adj0.y / 100.0);
        let y_in = luma(p);
        if (y_in > 1e-6) {
            p = p * ((0.18 * pow(y_in / 0.18, gamma)) / y_in);
        }
    }

    // 4. Highlights -> shadows -> whites -> blacks, sequentially, each
    //    recomputing luma from the previous step's output. The global stage's
    //    Gaussian regional halo mask is the one deliberate omission: a
    //    per-pixel function cannot see neighbours, and a feathered local mask
    //    is already a smooth region.
    if ((present & P_HIGHLIGHTS) != 0u) {
        let h_amount = w * layer.adj0.z / 100.0;
        p = p * highlights_mult(luma(p), h_amount, 1.0 + h_amount * 2.0, 1.0 + 2.0 * abs(h_amount));
    }
    if ((present & P_SHADOWS) != 0u) {
        p = p * shadows_mult(luma(p), w * layer.adj0.w / 100.0);
    }
    if ((present & P_WHITES) != 0u) {
        p = p * (1.0 + (w * layer.adj1.x / 200.0) * smoothstep(0.5, 1.0, luma(p)));
    }
    if ((present & P_BLACKS) != 0u) {
        // Sign-branched exactly as the Rust stage: multiplicative crush below
        // zero, additive lift at or above it (so a Y=0 pixel can still lift).
        let weight = 1.0 - smoothstep(0.0, 0.2, luma(p));
        let b_amount = w * layer.adj1.y / 100.0;
        if (b_amount < 0.0) {
            p = p * (1.0 + b_amount * weight);
        } else {
            let delta = (w * layer.adj1.y / 400.0) * weight;
            p = p + vec3<f32>(delta, delta, delta);
        }
    }

    // 5. Saturation, then 6. vibrance — both Oklab chroma moves.
    if ((present & P_SATURATION) != 0u) {
        p = saturation_pixel(p, 1.0 + (w * layer.adj1.z) / 100.0);
    }
    if ((present & P_VIBRANCE) != 0u) {
        p = vibrance_pixel(p, (w * layer.adj1.w) / 100.0);
    }
    return p;
}

@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) gid: vec3<u32>, @builtin(num_workgroups) ng: vec3<u32>) {
    let i = gid.y * ng.x * 64u + gid.x;
    if (i >= params.count) {
        return;
    }
    let px = input_buf[i];
    let x = params.origin_x + (i % params.buf_width);
    let y = params.origin_y + (i / params.buf_width);
    let n = vec2<f32>(f32(x) * params.inv_w, f32(y) * params.inv_h);

    var p = px.rgb;
    // Layers composite in order, in registers — see the module header for why
    // this is identical to the Rust stage's per-layer whole-image passes.
    for (var li: u32 = 0u; li < params.layer_count; li = li + 1u) {
        let layer = layers[li];
        if (layer.flags.x == 0.0) {
            continue;   // layer carries no controls; the Rust stage skips it
        }
        let w = mask_weight(layer, n);
        if (w <= 0.0) {
            continue;
        }
        p = apply_pixel(p, layer, w);
    }
    output_buf[i] = vec4<f32>(p, px.a);
}
