// sharpen_luma.wgsl — RGBA → luma plane (epic #925 P3 wave 2 / #991). The luma
// extract for `raw_core::stages::sharpen::apply`, which computes
// `luma = LUMA_R*r + LUMA_G*g + LUMA_B*b` (BT.2020 weights) once and reuses it
// for BOTH the unsharp blur and the edge-mix gradient.
//
// PARITY-CRITICAL — the weighted sum order matches raw-core's
//   `LUMA_R * p[0] + LUMA_G * p[1] + LUMA_B * p[2]`
// so the plane is bit-identical to raw-core's `luma` Vec. Distinct from
// guided_luma.wgsl, which ALSO emits luma² (sharpen needs only luma). 2 storage:
// RGBA-in + luma-out.

// BT.2020 luma weights — `raw_core::stages::sharpen::{LUMA_R,LUMA_G,LUMA_B}`.
const LUMA_R: f32 = 0.2627;
const LUMA_G: f32 = 0.6780;
const LUMA_B: f32 = 0.0593;

struct Params {
    count: u32,
    _pad0: u32,
    _pad1: u32,
    _pad2: u32,
};

@group(0) @binding(0) var<uniform> params: Params;
@group(0) @binding(1) var<storage, read> src_buf: array<vec4<f32>>;
@group(0) @binding(2) var<storage, read_write> luma_buf: array<f32>;

@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) gid: vec3<u32>, @builtin(num_workgroups) ng: vec3<u32>) {
    let i = gid.y * ng.x * 64u + gid.x;
    if (i >= params.count) {
        return;
    }
    let p = src_buf[i];
    luma_buf[i] = LUMA_R * p.r + LUMA_G * p.g + LUMA_B * p.b;
}
