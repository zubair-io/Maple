// defringe.wgsl — chroma-fringe suppression at high-contrast edges
// (#3407 per-mask, #3411 global).
//
// Port of `raw_core::stages::defringe::apply_params`. ONE kernel serves both
// callers: `local_spatial.rs` runs it over a scratch copy for the per-mask
// control's single amount, and the live-chain builder pushes it at develop's
// 12a slot for the global ACR controls. `bands_active` is what separates
// them — when it is 0 the hue block below is skipped entirely, so the
// per-mask path executes exactly the instruction sequence it did before the
// two were unified.
//
// One gather per pixel: the relative luma gradient (central differences,
// clamp-to-edge, divided by the pixel's own luma so the detector is
// exposure-invariant) drives a smoothstep edge weight; the pixel's colour
// then decides how much of that edge it is eligible for; and its Oklab
// chroma is scaled by `1 - k * edge`. Oklab L is untouched, so the
// suppression cannot darken or brighten anything.
//
// ## How the color matrices get here
//
// WGSL has no `#include`. The generated `generated/color_matrices.wgsl` is
// concatenated AHEAD of this source at module creation (see
// `context_pipelines.rs`), same as vibrance / saturation, supplying the
// rec2020 <-> Oklab `mul_*` helpers.

struct Params {
    count: u32,              // number of RGBA pixels
    width: u32,              // row stride in pixels
    height: u32,
    bands_active: u32,       // 0 = per-mask (hue-agnostic), 1 = global bands
    all_hues_strength: f32,  // per-mask amount / 100, clamped to [0, 1]
    purple_strength: f32,    // global amount / 20, clamped to [0, 1]
    purple_lo: f32,          // band edges on ACR's [0, 100] hue axis
    purple_hi: f32,
    green_strength: f32,
    green_lo: f32,
    green_hi: f32,
    _pad: f32,
};

@group(0) @binding(0) var<uniform> params: Params;
@group(0) @binding(1) var<storage, read> input_buf: array<vec4<f32>>;
@group(0) @binding(2) var<storage, read_write> output_buf: array<vec4<f32>>;

// Verbatim from `raw_core::stages::defringe`.
const LUMA_REC2020: vec3<f32> = vec3<f32>(0.2627, 0.6780, 0.0593);
const EDGE_LO: f32 = 0.35;
const EDGE_HI: f32 = 1.2;
const LUMA_FLOOR: f32 = 1e-6;
const PURPLE_BAND_LO_DEG: f32 = 255.0;
const PURPLE_BAND_HI_DEG: f32 = 345.0;
const GREEN_BAND_LO_DEG: f32 = 100.0;
const GREEN_BAND_HI_DEG: f32 = 190.0;
const HUE_FEATHER: f32 = 15.0;
const RAD_TO_DEG: f32 = 57.295779513082322865;

fn luma_at(i: u32) -> f32 {
    let p = input_buf[i].rgb;
    return LUMA_REC2020.x * p.x + LUMA_REC2020.y * p.y + LUMA_REC2020.z * p.z;
}

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

// Hermite smoothstep guarded exactly as the Rust helper is: WGSL's built-in
// is undefined when e1 <= e0, and an inverted or degenerate band reaches
// this with lo >= hi.
fn smoothstep_guarded(e0: f32, e1: f32, x: f32) -> f32 {
    if (e1 <= e0) {
        if (x >= e1) { return 1.0; }
        return 0.0;
    }
    let t = clamp((x - e0) / (e1 - e0), 0.0, 1.0);
    return t * t * (3.0 - 2.0 * t);
}

// Band membership in [0, 1]: 1 inside [lo, hi], feathering to 0 over
// HUE_FEATHER on each side. An inverted band (hi <= lo) selects nothing.
fn band_weight(t: f32, lo: f32, hi: f32) -> f32 {
    if (hi <= lo) {
        return 0.0;
    }
    return smoothstep_guarded(lo - HUE_FEATHER, lo, t)
        * (1.0 - smoothstep_guarded(hi, hi + HUE_FEATHER, t));
}

fn axis_position(hue_deg: f32, band_lo: f32, band_hi: f32) -> f32 {
    return 100.0 * (hue_deg - band_lo) / (band_hi - band_lo);
}

@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) gid: vec3<u32>, @builtin(num_workgroups) ng: vec3<u32>) {
    let i = gid.y * ng.x * 64u + gid.x;
    if (i >= params.count) {
        return;
    }
    let px = input_buf[i];
    let x = i % params.width;
    let y = i / params.width;

    let centre = luma_at(i);
    if (centre <= LUMA_FLOOR) {
        output_buf[i] = px;
        return;
    }
    // Clamp-to-edge neighbours, matching the Rust stage's `saturating_sub` /
    // `min(dim - 1)` index arithmetic exactly.
    let left = select(x - 1u, 0u, x == 0u);
    let right = min(x + 1u, params.width - 1u);
    let up = select(y - 1u, 0u, y == 0u);
    let down = min(y + 1u, params.height - 1u);

    let dx = luma_at(y * params.width + right) - luma_at(y * params.width + left);
    let dy = luma_at(down * params.width + x) - luma_at(up * params.width + x);
    let relative = (abs(dx) + abs(dy)) / centre;
    let edge = smoothstep(EDGE_LO, EDGE_HI, relative);
    if (edge <= 0.0) {
        output_buf[i] = px;
        return;
    }

    let lab = rec2020_to_oklab(px.rgb);
    // How much of that edge this pixel's COLOUR is eligible for. The
    // per-mask caller leaves `bands_active` at 0 and takes the constant
    // straight through, never evaluating a hue.
    var strength = params.all_hues_strength;
    if (params.bands_active != 0u) {
        // Rust computes `b.atan2(a).to_degrees().rem_euclid(360.0)`; WGSL's
        // atan2 has the same [-pi, pi] range, and adding 360 before the
        // modulo reproduces `rem_euclid` for that range without a branch.
        let hue = (atan2(lab.z, lab.y) * RAD_TO_DEG + 360.0) % 360.0;
        let purple = params.purple_strength * band_weight(
            axis_position(hue, PURPLE_BAND_LO_DEG, PURPLE_BAND_HI_DEG),
            params.purple_lo,
            params.purple_hi
        );
        let green = params.green_strength * band_weight(
            axis_position(hue, GREEN_BAND_LO_DEG, GREEN_BAND_HI_DEG),
            params.green_lo,
            params.green_hi
        );
        strength = max(strength, max(purple, green));
    }
    if (strength <= 0.0) {
        output_buf[i] = px;
        return;
    }

    let scale = 1.0 - strength * edge;
    let out = oklab_to_rec2020(vec3<f32>(lab.x, lab.y * scale, lab.z * scale));
    output_buf[i] = vec4<f32>(out, px.a);
}
