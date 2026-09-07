// defringe.wgsl — chroma-fringe suppression at high-contrast edges (#3407).
//
// Port of `raw_core::stages::defringe::apply`. Maple has no GLOBAL defringe
// slider; this kernel exists for the per-mask control, which
// `local_spatial.rs` runs over a scratch copy and blends by the mask weight.
//
// One gather per pixel: the relative luma gradient (central differences,
// clamp-to-edge, divided by the pixel's own luma so the detector is
// exposure-invariant) drives a smoothstep edge weight, and the pixel's Oklab
// chroma is scaled by `1 - strength * edge`. Oklab L is untouched, so the
// suppression cannot darken or brighten anything.
//
// ## How the color matrices get here
//
// WGSL has no `#include`. The generated `generated/color_matrices.wgsl` is
// concatenated AHEAD of this source at module creation (see
// `context_pipelines.rs`), same as vibrance / saturation, supplying the
// rec2020 <-> Oklab `mul_*` helpers.

struct Params {
    count: u32,     // number of RGBA pixels
    width: u32,     // row stride in pixels
    height: u32,
    strength: f32,  // amount / 100, clamped to [0, 1]
};

@group(0) @binding(0) var<uniform> params: Params;
@group(0) @binding(1) var<storage, read> input_buf: array<vec4<f32>>;
@group(0) @binding(2) var<storage, read_write> output_buf: array<vec4<f32>>;

// Verbatim from `raw_core::stages::defringe`.
const LUMA_REC2020: vec3<f32> = vec3<f32>(0.2627, 0.6780, 0.0593);
const EDGE_LO: f32 = 0.35;
const EDGE_HI: f32 = 1.2;
const LUMA_FLOOR: f32 = 1e-6;

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
    let scale = 1.0 - params.strength * edge;
    let lab = rec2020_to_oklab(px.rgb);
    let out = oklab_to_rec2020(vec3<f32>(lab.x, lab.y * scale, lab.z * scale));
    output_buf[i] = vec4<f32>(out, px.a);
}
