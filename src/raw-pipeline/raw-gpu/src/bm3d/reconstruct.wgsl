@group(0) @binding(1) var<storage, read> noisy: array<vec4<f32>>;
@group(0) @binding(2) var<storage, read> accum: array<vec2<f32>>;
@group(0) @binding(3) var<storage, read_write> output: array<vec4<f32>>;
@group(0) @binding(4) var<storage,read> groups:array<u32>;

fn horizontal_blur(at: vec2<u32>) -> f32 {
    let center = luminance(noisy[at.y * p.dims.x + at.x].rgb);
    var num = 0.0;
    var den = 1.0;
    let kw = p.highpass;
    for (var d = 1u; d <= 2u; d++) {
        if at.x >= d {
            num += kw[d] * (luminance(noisy[at.y * p.dims.x + at.x - d].rgb) - center);
            den += kw[d];
        }
        if at.x + d < p.dims.x {
            num += kw[d] * (luminance(noisy[at.y * p.dims.x + at.x + d].rgb) - center);
            den += kw[d];
        }
    }
    return center + num / den;
}

@compute @workgroup_size(64)
fn reconstruct(@builtin(global_invocation_id) id: vec3<u32>) {
    let i = index(id);
    let count = p.dims.x * p.dims.y;
    if i >= count { return; }
    let rgb = noisy[i].rgb;
    let original_y = luminance(rgb);
    let original = vec3<f32>(original_y, rgb.r - original_y, rgb.b - original_y);
    // raw-core's hard pass is exact identity when no coefficient can be
    // rejected. Preserve that same basic guide, including signed values.
    if p.control.y==0u && bitcast<f32>(groups[0])<=0.0 {
        output[i]=vec4<f32>(original,noisy[i].a);
        return;
    }
    var filtered = original;
    for (var c = 0u; c < 3u; c++) {
        let sums = accum[c * count + i];
        if sums.y > 0.0 { filtered[c] += sums.x / sums.y; }
    }
    if p.control.y == 0u {
        output[i] = vec4<f32>(filtered, noisy[i].a);
        return;
    }
    let xy = vec2<u32>(i % p.dims.x, i / p.dims.x);
    let center = horizontal_blur(xy);
    var num = 0.0;
    var den = 1.0;
    let kw = p.highpass;
    for (var d = 1u; d <= 2u; d++) {
        if xy.y >= d {
            num += kw[d] * (horizontal_blur(xy - vec2<u32>(0u, d)) - center);
            den += kw[d];
        }
        if xy.y + d < p.dims.y {
            num += kw[d] * (horizontal_blur(xy + vec2<u32>(0u, d)) - center);
            den += kw[d];
        }
    }
    filtered.x += p.extra.y * (original_y - (center + num / den));
    let delta = filtered - original;
    let dr = delta.x + delta.y;
    let db = delta.x + delta.z;
    let dg = (delta.x - p.luma.x * dr - p.luma.z * db) / p.luma.y;
    output[i] = vec4<f32>(rgb + vec3<f32>(dr, dg, db), noisy[i].a);
}
