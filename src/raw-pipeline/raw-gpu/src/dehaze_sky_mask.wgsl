// dehaze_sky_mask.wgsl — the raw "sky / no-dark-pixel" mask for dehaze (issue
// #272, epic #925 P2 wave 3b / #990).
//
// The dark-channel prior fails on sky / snow / white walls — every channel is
// high there, so the dark channel is high, transmission collapses, and recovery
// halos. Dehaze detects those regions by smoothstepping the dark channel and
// suppresses the recovery where the mask is high.
//
// This kernel emits the RAW (un-blurred) mask: one smoothstep per pixel. The
// light box-blur that softens the transition band (SKY_MASK_BLUR_RADIUS = 8) is
// the scalar `box_blur.wgsl` primitive, encoded right after this — no separate
// blur kernel.
//
// PARITY-CRITICAL — mirrors `raw_core::stages::dehaze::sky_mask`'s raw step:
//   raw = smoothstep(SKY_MASK_LOW, SKY_MASK_HIGH, dc)
//   SKY_MASK_LOW = 0.40, SKY_MASK_HIGH = 0.60.
// WGSL's builtin `smoothstep(e0, e1, x)` is the SAME cubic Hermite
// (`t*t*(3-2t)` with `t = clamp((x-e0)/(e1-e0), 0, 1)`) raw-core's `smoothstep`
// helper implements, so it matches bit-for-bit.

const SKY_MASK_LOW: f32 = 0.40;
const SKY_MASK_HIGH: f32 = 0.60;

struct Params {
    count: u32,   // number of plane samples (width * height)
    _pad0: u32,
    _pad1: u32,
    _pad2: u32,
};

@group(0) @binding(0) var<uniform> params: Params;
@group(0) @binding(1) var<storage, read> dc_buf: array<f32>;
@group(0) @binding(2) var<storage, read_write> mask_buf: array<f32>;

@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) gid: vec3<u32>, @builtin(num_workgroups) ng: vec3<u32>) {
    let i = gid.y * ng.x * 64u + gid.x;
    if (i >= params.count) {
        return;
    }
    mask_buf[i] = smoothstep(SKY_MASK_LOW, SKY_MASK_HIGH, dc_buf[i]);
}
