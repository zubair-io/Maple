// dehaze_downsample.wgsl — block-average the pre-dehaze image onto the haze
// map's fixed proxy grid (#3287). Mirrors `raw_core::stages::dehaze` map
// `resample` exactly: proxy pixel i covers source columns
// [i*W/pw, max(i*W/pw + 1, (i+1)*W/pw)) (integer division), likewise rows,
// summed row-major per channel and divided by the cell's pixel count. A
// smaller source is therefore sampled nearest, a larger one area-averaged.

struct Params {
    src_width: u32,
    src_height: u32,
    proxy_width: u32,
    proxy_height: u32,
};

@group(0) @binding(0) var<uniform> params: Params;
@group(0) @binding(1) var<storage, read> input_buf: array<vec4<f32>>;
@group(0) @binding(2) var<storage, read_write> output_buf: array<vec4<f32>>;

fn span_start(i: u32, src: u32, dst: u32) -> u32 {
    return i * src / dst;
}

fn span_end(i: u32, src: u32, dst: u32) -> u32 {
    return max(span_start(i, src, dst) + 1u, (i + 1u) * src / dst);
}

@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) gid: vec3<u32>, @builtin(num_workgroups) ng: vec3<u32>) {
    let pw = params.proxy_width;
    let ph = params.proxy_height;
    let k = gid.y * ng.x * 64u + gid.x;
    if (k >= pw * ph) {
        return;
    }
    let i = k % pw;
    let j = k / pw;
    let x0 = span_start(i, params.src_width, pw);
    let x1 = span_end(i, params.src_width, pw);
    let y0 = span_start(j, params.src_height, ph);
    let y1 = span_end(j, params.src_height, ph);
    var sum = vec3<f32>(0.0, 0.0, 0.0);
    for (var y: u32 = y0; y < y1; y = y + 1u) {
        let row = y * params.src_width;
        for (var x: u32 = x0; x < x1; x = x + 1u) {
            sum = sum + input_buf[row + x].rgb;
        }
    }
    let n = f32((y1 - y0) * (x1 - x0));
    output_buf[k] = vec4<f32>(sum / n, 1.0);
}
