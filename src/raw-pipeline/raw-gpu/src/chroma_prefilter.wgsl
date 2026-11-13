// Sparse cross-bilateral chroma prefilter. All tuning comes from raw-core.
struct Params {
    width: u32,
    height: u32,
    sigma: f32,
    pedestal: f32,
    luma: vec4<f32>,
    taps: array<vec4<f32>, 8>,
};
@group(0) @binding(0) var<uniform> params: Params;
@group(0) @binding(1) var<storage, read> src: array<vec4<f32>>;
@group(0) @binding(2) var<storage, read_write> dst: array<vec4<f32>>;

fn luma(p: vec3<f32>) -> f32 {
    return params.luma.x * p.r + params.luma.y * p.g + params.luma.z * p.b;
}

@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) id: vec3<u32>) {
    let i = id.x + id.y * 65535u * 64u;
    if i >= params.width * params.height { return; }
    let p = src[i];
    let yc = luma(p.rgb);
    let c = vec2<f32>(p.r - yc, p.b - yc);
    var num = vec2<f32>(0.0);
    var den = 1.0;
    var uniform_neighborhood = true;
    let xy = vec2<i32>(i32(i % params.width), i32(i / params.width));
    for (var k = 0u; k < 8u; k++) {
        let tap = params.taps[k];
        let at = xy + vec2<i32>(tap.xy);
        if any(at < vec2<i32>(0)) || at.x >= i32(params.width) || at.y >= i32(params.height) { continue; }
        let q = src[u32(at.y) * params.width + u32(at.x)];
        uniform_neighborhood = uniform_neighborhood && all(q.rgb == p.rgb);
        let yt = luma(q.rgb);
        let scale = abs(0.5 * (yc + yt)) + params.pedestal;
        let t = (yt - yc) / (params.sigma * scale);
        let weight = tap.z / (1.0 + t * t);
        num += weight * (vec2<f32>(q.r - yt, q.b - yt) - c);
        den += weight;
    }
    var delta = num / den;
    if uniform_neighborhood || all(delta == vec2<f32>(0.0)) {
        dst[i] = p;
        return;
    }
    let filtered = c + delta;
    let original_mag = dot(c, c);
    let filtered_mag = dot(filtered, filtered);
    if filtered_mag > original_mag {
        delta = filtered * sqrt(original_mag / filtered_mag) - c;
    }
    let dg = -(params.luma.x * delta.x + params.luma.z * delta.y) / params.luma.y;
    dst[i] = vec4<f32>(p.r + delta.x, p.g + dg, p.b + delta.y, p.a);
}
