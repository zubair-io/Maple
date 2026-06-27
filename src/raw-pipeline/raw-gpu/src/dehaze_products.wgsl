// dehaze_products.wgsl — pre-blur products for dehaze's GENERAL guided filter
// (epic #925 P2 wave 3b / #990).
//
// Dehaze refines the raw transmission `t` with a guided filter whose GUIDE is
// scene-linear luma and whose filtered signal `p` is `t` — i.e. guide != p (the
// GENERAL case, unlike clarity/texture's self-guided `guide == p`). The general
// case needs four box-blurred means: mean_i = blur(luma), mean_p = blur(t),
// mean_ip = blur(luma·t), mean_ii = blur(luma·luma).
//
// To stay within `downlevel_defaults()`'s 4-storage-buffer cap in the downstream
// a/b kernel, we PACK the four pre-blur quantities into TWO vec2 planes:
//   m1 = (luma,    t)        → blur → (mean_i,  mean_p)
//   m2 = (luma·t,  luma·luma) → blur → (mean_ip, mean_ii)
// A vec2 box blur is two independent scalar blurs, so each component is
// bit-identical to blurring it alone. The a/b kernel then reads just two vec2
// planes (mean_m1, mean_m2) and writes one vec2 (a, b) → 3 storage buffers.
//
// PARITY-CRITICAL — luma is the SAME Rec.2020 weighted sum (same add order)
// `raw_core::stages::dehaze::apply` uses for its guide:
//   guide = 0.2627·r + 0.6780·g + 0.0593·b.

const LUMA_R: f32 = 0.2627;
const LUMA_G: f32 = 0.6780;
const LUMA_B: f32 = 0.0593;

struct Params {
    count: u32,   // number of pixels (width * height)
    _pad0: u32,
    _pad1: u32,
    _pad2: u32,
};

@group(0) @binding(0) var<uniform> params: Params;
@group(0) @binding(1) var<storage, read> image_buf: array<vec4<f32>>;
@group(0) @binding(2) var<storage, read> t_buf: array<f32>;
@group(0) @binding(3) var<storage, read_write> m1_buf: array<vec2<f32>>;
@group(0) @binding(4) var<storage, read_write> m2_buf: array<vec2<f32>>;

@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) gid: vec3<u32>, @builtin(num_workgroups) ng: vec3<u32>) {
    let i = gid.y * ng.x * 64u + gid.x;
    if (i >= params.count) {
        return;
    }
    let p = image_buf[i];
    let luma = LUMA_R * p.r + LUMA_G * p.g + LUMA_B * p.b;
    let t = t_buf[i];
    m1_buf[i] = vec2<f32>(luma, t);
    m2_buf[i] = vec2<f32>(luma * t, luma * luma);
}
