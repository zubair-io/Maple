// color_curves.wgsl — scene-linear Oklab secondary color curves (#5041, Stage 22b).
//
// Positioned immediately after `hsl` (Stage 22) and before `clarity` (Stage 23).
// Evaluates six 256-sample baked offset LUTs (d(u) = y(u) - 0.5 in [-0.5, +0.5]):
//   slot 0 (0..256):     hue_vs_hue   (periodic over u_H in [0, 1))
//   slot 1 (256..512):   hue_vs_sat   (periodic over u_H in [0, 1))
//   slot 2 (512..768):   hue_vs_luma  (periodic over u_H in [0, 1))
//   slot 3 (768..1024):  luma_vs_sat  (clamped over scene-referred log-EV u_L in [0, 1])
//   slot 4 (1024..1280): sat_vs_sat   (clamped over u_C = clamp(C / 0.32, 0, 1))
//   slot 5 (1280..1536): sat_vs_luma  (clamped over u_C = clamp(C / 0.32, 0, 1))
//
// Compiled with `compile_with_matrices` for the Oklab round-trip helpers.
// Bind layout: uniform @0 (Params), src storage @1, dst storage @2, lut storage @3
// (3 storage buffers, within the <=4/stage project budget).

struct Params {
    chroma_gate_c0: f32,
    count: u32,
    is_identity: u32,
    _pad: u32,
};

@group(0) @binding(0) var<uniform> params: Params;
@group(0) @binding(1) var<storage, read> input_buf: array<vec4<f32>>;
@group(0) @binding(2) var<storage, read_write> output_buf: array<vec4<f32>>;
@group(0) @binding(3) var<storage, read> lut_buf: array<f32>;

const LUT_LEN: u32 = 256u;
const MAX_OKLAB_CHROMA: f32 = 0.32;
const HUE_MAX_RAD: f32 = 1.047197551; // 60 deg in radians (PI / 3)
const LUMA_MAX_SCALE: f32 = 0.30;
const TWO_PI: f32 = 6.283185307179586;

const REC2020_LUMA_R: f32 = 0.26270021;
const REC2020_LUMA_G: f32 = 0.67799807;
const REC2020_LUMA_B: f32 = 0.05930172;

const GAMUT_EPS: f32 = 1e-5;
const GAMUT_KNEE_FRACTION: f32 = 0.8;
const GAMUT_BISECT_ITERS: i32 = 24;

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
    let srgb = mul_lms_to_srgb(lms);
    return mul_srgb_to_rec2020(srgb);
}

fn smoothstep_fn(e0: f32, e1: f32, x: f32) -> f32 {
    let t = clamp((x - e0) / (e1 - e0), 0.0, 1.0);
    return t * t * (3.0 - 2.0 * t);
}

fn sample_periodic(slot: u32, u: f32) -> f32 {
    let u_wrapped = u - floor(u);
    let pos = u_wrapped * f32(LUT_LEN);
    let p_floor = floor(pos);
    let i0 = u32(p_floor) & (LUT_LEN - 1u);
    let i1 = (i0 + 1u) & (LUT_LEN - 1u);
    let frac = pos - p_floor;
    let base = slot * LUT_LEN;
    return lut_buf[base + i0] * (1.0 - frac) + lut_buf[base + i1] * frac;
}

fn sample_clamped(slot: u32, u: f32) -> f32 {
    let pos = clamp(u, 0.0, 1.0) * f32(LUT_LEN - 1u);
    let p_floor = floor(pos);
    let i0 = min(u32(p_floor), LUT_LEN - 1u);
    let i1 = min(i0 + 1u, LUT_LEN - 1u);
    let frac = pos - p_floor;
    let base = slot * LUT_LEN;
    return lut_buf[base + i0] * (1.0 - frac) + lut_buf[base + i1] * frac;
}

fn min_channel_in_gamut(rgb: vec3<f32>) -> bool {
    let min_c = min(rgb.x, min(rgb.y, rgb.z));
    return min_c >= -GAMUT_EPS;
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

    let p = input_buf[i];
    if (params.is_identity != 0u) {
        output_buf[i] = p;
        return;
    }

    let rgb = p.rgb;
    let lab = rec2020_to_oklab(rgb);
    var l = lab.x;
    let a = lab.y;
    let b = lab.z;
    let c = sqrt(a * a + b * b);

    let c0 = params.chroma_gate_c0;
    if (c < c0) {
        output_buf[i] = p;
        return;
    }
    let chroma_gate = smoothstep_fn(c0, 2.0 * c0, c);

    var hue = atan2(b, a);
    if (hue < 0.0) {
        hue = hue + TWO_PI;
    }
    let u_h = (hue / TWO_PI) - floor(hue / TWO_PI);
    let u_c = clamp(c / MAX_OKLAB_CHROMA, 0.0, 1.0);
    let y_luma = max(REC2020_LUMA_R * rgb.x + REC2020_LUMA_G * rgb.y + REC2020_LUMA_B * rgb.z, 1e-6);
    let u_l = clamp(0.5 + 0.125 * log2(y_luma / 0.18), 0.0, 1.0);

    let d_hvh = sample_periodic(0u, u_h);
    let delta_hue_rad = chroma_gate * d_hvh * 2.0 * HUE_MAX_RAD;

    let d_hvs = sample_periodic(1u, u_h);
    let d_lvs = sample_clamped(3u, u_l);
    let d_svs = sample_clamped(4u, u_c);
    let s_hvs = max(1.0 + chroma_gate * 2.0 * d_hvs, 0.0);
    let s_lvs = max(1.0 + chroma_gate * 2.0 * d_lvs, 0.0);
    let s_svs = max(1.0 + chroma_gate * 2.0 * d_svs, 0.0);
    let c_target = max(c * s_hvs * s_lvs * s_svs, 0.0);

    let d_hvl = sample_periodic(2u, u_h);
    let d_svl = sample_clamped(5u, u_c);
    let s_hvl = 1.0 + chroma_gate * 2.0 * LUMA_MAX_SCALE * d_hvl;
    let s_svl = 1.0 + chroma_gate * 2.0 * LUMA_MAX_SCALE * d_svl;
    l = max(l * s_hvl * s_svl, 0.0);

    let a_hat = a / c;
    let b_hat = b / c;
    let cos_dh = cos(delta_hue_rad);
    let sin_dh = sin(delta_hue_rad);
    let rot_a_hat = a_hat * cos_dh - b_hat * sin_dh;
    let rot_b_hat = a_hat * sin_dh + b_hat * cos_dh;

    let rgb_target = oklab_to_rec2020(vec3<f32>(l, rot_a_hat * c_target, rot_b_hat * c_target));
    if (min_channel_in_gamut(rgb_target)) {
        output_buf[i] = vec4<f32>(rgb_target, p.a);
        return;
    }

    let c_hull = bisect_gamut_hull(l, rot_a_hat, rot_b_hat, c_target);
    let c_out = soft_compress(c_target, c_hull);
    let out_rgb = oklab_to_rec2020(vec3<f32>(l, rot_a_hat * c_out, rot_b_hat * c_out));
    output_buf[i] = vec4<f32>(out_rgb, p.a);
}
