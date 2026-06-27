// vignette.wgsl — scene-linear radial EV gain (#1109, tone/zoom design
// § 10.1; raw_core::stages::vignette::apply_windowed).
//
// A pure point op GIVEN the window uniforms: each invocation derives its
// absolute full-image pixel coordinate from the buffer index + the tile
// origin, so a tile render produces the exact pixels of the full-frame
// render (tile-safe by construction — no overlap needed). The live chain
// passes origin (0, 0) and full = the buffer dims.
//
//   nx   = (px + 0.5) · inv_half_w − 1        // [-1, 1] at frame edges
//   ny   = (py + 0.5) · inv_half_h − 1
//   r    = √(nx² + ny²)                        // elliptical, aspect-matched
//   m(r) = smoothstep(e0, e1, r)               // edges hoisted host-side
//   gain = exp2(ev · m)                        // ev = 1.5 · amount/100
//
// e0/e1/ev/inv_half_* are hoisted on the host by the SAME float sequence
// raw-core's `vignette_mask_params` uses (the Pass transcribes it; the
// parity test pins both against the real raw-core stage). Inside the e0
// radius m = 0, so gain = exp2(±0) = 1.0 and the ×1.0 multiply is
// bit-exact identity — the centre region is untouched without a branch.
//
// Parity oracle: raw-gpu::apply_vignette (CPU), a line-for-line copy of
// raw_core::stages::vignette::apply_windowed. Gate < 1e-4 vs that oracle
// AND vs the real raw-core stage (see vignette/tests.rs).

struct Params {
    e0: f32,           // mask inner edge (m0 − width/2)
    e1: f32,           // mask outer edge (m0 + width/2)
    ev: f32,           // K_EV · amount / 100
    inv_half_w: f32,   // 2 / full_width
    inv_half_h: f32,   // 2 / full_height
    count: u32,        // number of RGBA pixels in the buffer
    buf_width: u32,    // buffer row stride in pixels
    origin_x: u32,     // buffer's left edge in full-image pixels
    origin_y: u32,     // buffer's top edge in full-image pixels
    _pad0: u32,
    _pad1: u32,
    _pad2: u32,
};

@group(0) @binding(0) var<uniform> params: Params;
@group(0) @binding(1) var<storage, read> input_buf: array<vec4<f32>>;
@group(0) @binding(2) var<storage, read_write> output_buf: array<vec4<f32>>;

@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) gid: vec3<u32>, @builtin(num_workgroups) ng: vec3<u32>) {
    let i = gid.y * ng.x * 64u + gid.x;
    if (i >= params.count) {
        return;
    }
    let x = i % params.buf_width;
    let y = i / params.buf_width;
    let px = params.origin_x + x;
    let py = params.origin_y + y;

    let nx = (f32(px) + 0.5) * params.inv_half_w - 1.0;
    let ny = (f32(py) + 0.5) * params.inv_half_h - 1.0;
    let r = sqrt(nx * nx + ny * ny);
    // WGSL smoothstep matches raw-core's clamp + t²(3−2t) form exactly.
    let m = smoothstep(params.e0, params.e1, r);
    let gain = exp2(params.ev * m);

    let p = input_buf[i];
    output_buf[i] = vec4<f32>(p.rgb * gain, p.a);
}
