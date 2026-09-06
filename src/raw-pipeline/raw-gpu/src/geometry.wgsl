// Matrix rows are prepared by raw-core. All sampling precedes quantization.
struct Params {
    r0: vec4<f32>, r1: vec4<f32>, r2: vec4<f32>,
    width: u32, height: u32, count: u32, pad: u32,
}
@group(0) @binding(0) var<uniform> p: Params;
@group(0) @binding(1) var<storage, read> src: array<vec4<f32>>;
@group(0) @binding(2) var<storage, read_write> dst: array<vec4<f32>>;

@compute @workgroup_size(256)
fn main(@builtin(global_invocation_id) id: vec3<u32>) {
    let index = id.x;
    if index >= p.count { return; }
    let size = vec2<f32>(f32(p.width), f32(p.height));
    let uv = (vec2<f32>(f32(index % p.width), f32(index / p.width)) + 0.5) / size;
    let q = vec3<f32>(uv, 1.0);
    let z = dot(p.r2.xyz, q);
    dst[index] = vec4<f32>(0.0, 0.0, 0.0, 1.0);
    if z <= 0.000001 { return; }
    let source = vec2<f32>(dot(p.r0.xyz, q), dot(p.r1.xyz, q)) / z;
    if any(source < vec2<f32>(0.0)) || any(source > vec2<f32>(1.0)) { return; }
    let pixel = clamp(source * size - 0.5, vec2<f32>(0.0), size - 1.0);
    let lo = vec2<u32>(floor(pixel));
    let hi = min(lo + vec2<u32>(1), vec2<u32>(p.width - 1, p.height - 1));
    let t = fract(pixel);
    let top = src[lo.y*p.width+lo.x] * (1.0-t.x) + src[lo.y*p.width+hi.x] * t.x;
    let bottom = src[hi.y*p.width+lo.x] * (1.0-t.x) + src[hi.y*p.width+hi.x] * t.x;
    dst[index] = top * (1.0-t.y) + bottom * t.y;
}
