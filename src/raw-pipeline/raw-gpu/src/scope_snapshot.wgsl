// scope_snapshot.wgsl — box-mean downsample of the display-encoded chain
// buffer into a packed-RGB8 snapshot (#3251). Twin of
// raw_core::scope::snapshot_rgba_f32: one invocation per OUTPUT cell, the
// same integer cell bounds (`raw_core::scope::cell_span`) and the same
// row-major summation order, so the two producers visit identical pixels;
// only the final rounding of the mean can differ, and only on a tie.
//
// Output word `i` packs cell `i`'s channels as `r | g << 8 | b << 16`
// (storage buffers cannot address bytes); raw-gpu's `unpack_scope` unpacks
// them into the `3 * width * height` byte layout the hosts consume.

struct Params {
    src_w: u32,
    src_h: u32,
    dst_w: u32,
    dst_h: u32,
};

@group(0) @binding(0) var<uniform> params: Params;
@group(0) @binding(1) var<storage, read> src: array<vec4<f32>>;
@group(0) @binding(2) var<storage, read_write> out: array<u32>;

// raw_core::scope::cell_span's start bound. `o * src` stays far below u32
// range for any live-session frame (≤ 512 cells × a viewport-sized edge).
fn span_start(o: u32, src: u32, dst: u32) -> u32 {
    return (o * src) / dst;
}

fn quantize(v: f32) -> u32 {
    return u32(round(clamp(v, 0.0, 1.0) * 255.0));
}

@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) gid: vec3<u32>, @builtin(num_workgroups) ng: vec3<u32>) {
    let i = gid.y * ng.x * 64u + gid.x;
    let count = params.dst_w * params.dst_h;
    if (i >= count) {
        return;
    }
    let ox = i % params.dst_w;
    let oy = i / params.dst_w;
    let x0 = span_start(ox, params.src_w, params.dst_w);
    let x1 = min(max(span_start(ox + 1u, params.src_w, params.dst_w), x0 + 1u), params.src_w);
    let y0 = span_start(oy, params.src_h, params.dst_h);
    let y1 = min(max(span_start(oy + 1u, params.src_h, params.dst_h), y0 + 1u), params.src_h);
    var sum = vec3<f32>(0.0, 0.0, 0.0);
    for (var y = y0; y < y1; y = y + 1u) {
        for (var x = x0; x < x1; x = x + 1u) {
            sum = sum + src[y * params.src_w + x].rgb;
        }
    }
    let n = f32((y1 - y0) * (x1 - x0));
    let m = sum / n;
    out[i] = quantize(m.r) | (quantize(m.g) << 8u) | (quantize(m.b) << 16u);
}
