// guided_luma.wgsl — luma extraction for the guided-filter base/detail
// decomposition (epic #925 P2 wave 3b / #990). Shared by clarity / texture.
//
// Reads an RGBA f32 image and writes TWO scalar f32 planes:
//   luma  = LUMA_REC2020 . rgb   (the self-guide `p == guide`)
//   luma2 = luma * luma          (the `ii == ip` cross-product, pre-blur)
//
// PARITY-CRITICAL — mirrors `raw_core::stages::{clarity,texture}::apply`:
//   * LUMA_REC2020 = [0.2627, 0.6780, 0.0593], summed in the SAME order
//     raw-core uses (explicit weighted sum w0*r + w1*g + w2*b, not a `dot`).
//   * Self-guided guided filter: guide == p == luma, so `ip = guide*p` and
//     `ii = guide*guide` are the SAME value (luma²); we emit it once as `luma2`.

const LUMA_R: f32 = 0.2627;
const LUMA_G: f32 = 0.6780;
const LUMA_B: f32 = 0.0593;

struct Params {
    count: u32,   // number of RGBA pixels
    _pad0: u32,
    _pad1: u32,
    _pad2: u32,
};

@group(0) @binding(0) var<uniform> params: Params;
@group(0) @binding(1) var<storage, read> input_buf: array<vec4<f32>>;
@group(0) @binding(2) var<storage, read_write> luma_buf: array<f32>;
@group(0) @binding(3) var<storage, read_write> luma2_buf: array<f32>;

@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) gid: vec3<u32>, @builtin(num_workgroups) ng: vec3<u32>) {
    let i = gid.y * ng.x * 64u + gid.x;
    if (i >= params.count) {
        return;
    }
    let p = input_buf[i];
    // Explicit weighted sum, raw-core's add order: w0*r + w1*g + w2*b.
    let luma = LUMA_R * p.r + LUMA_G * p.g + LUMA_B * p.b;
    luma_buf[i] = luma;
    luma2_buf[i] = luma * luma;
}
