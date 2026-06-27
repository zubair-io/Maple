// box_blur_vec2.wgsl — separable box blur of a vec2 f32 plane, one axis per
// dispatch (epic #925 P2 wave 3b / #990). The vec2 sibling of `box_blur.wgsl`,
// used by dehaze's GENERAL guided filter to blur its packed (i, p) / (ip, ii)
// mean-planes in half the dispatches.
//
// PARITY-CRITICAL — identical border policy and window math to `box_blur.wgsl`
// (hence to `raw_core::stages::blur::box_blur_channel`): a SHRINKING partial
// average whose window at coordinate `c` spans `[max(0, c-r) ..= min(dim-1, c+r)]`,
// divided by the EXACT in-bounds count — NOT zero-pad, NOT clamp-to-edge. The
// two vec2 lanes accumulate independently, so each lane is bit-for-bit the same
// value a scalar `box_blur.wgsl` over that lane would produce (a vec2 add is two
// independent scalar adds in the same order). H then V, one axis per dispatch.

struct Params {
    width: u32,
    height: u32,
    radius: u32,
    axis: u32,    // 0 = horizontal sweep, 1 = vertical sweep
};

@group(0) @binding(0) var<uniform> params: Params;
@group(0) @binding(1) var<storage, read> input_buf: array<vec2<f32>>;
@group(0) @binding(2) var<storage, read_write> output_buf: array<vec2<f32>>;

@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) gid: vec3<u32>, @builtin(num_workgroups) ng: vec3<u32>) {
    let w = params.width;
    let h = params.height;
    let i = gid.y * ng.x * 64u + gid.x;
    if (i >= w * h) {
        return;
    }
    let r = i32(params.radius);
    let x = i32(i % w);
    let y = i32(i / w);

    var c: i32;
    var dim: i32;
    if (params.axis == 0u) {
        c = x;
        dim = i32(w);
    } else {
        c = y;
        dim = i32(h);
    }
    let lo = max(0, c - r);
    let hi = min(dim - 1, c + r);

    var acc: vec2<f32> = vec2<f32>(0.0, 0.0);
    if (params.axis == 0u) {
        let base = u32(y) * w;
        for (var xi: i32 = lo; xi <= hi; xi = xi + 1) {
            acc = acc + input_buf[base + u32(xi)];
        }
    } else {
        for (var yi: i32 = lo; yi <= hi; yi = yi + 1) {
            acc = acc + input_buf[u32(yi) * w + u32(x)];
        }
    }
    let count = f32(hi - lo + 1);
    output_buf[i] = acc / count;
}
