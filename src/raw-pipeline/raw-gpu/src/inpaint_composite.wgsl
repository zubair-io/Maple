// CPU oracle: raw-core/stages/inpaint_composite.rs (#3935).
struct Params {
    window: vec4<f32>,
    region: vec4<f32>,
    image_size: vec2<u32>,
    patch_size: vec2<u32>,
}
@group(0) @binding(0) var<uniform> params: Params;
@group(0) @binding(1) var<storage, read> src: array<vec4<f32>>;
@group(0) @binding(2) var<storage, read_write> dst: array<vec4<f32>>;
@group(0) @binding(3) var<storage, read> patch_pixels: array<vec4<f32>>;

fn lerp_exact(a: vec4<f32>, b: vec4<f32>, t: f32) -> vec4<f32> {
    if t == 0.0 { return a; }
    if t == 1.0 { return b; }
    return a + (b - a) * t;
}

fn sample_patch(p: vec2<f32>) -> vec4<f32> {
    let size = params.patch_size;
    let c = clamp(p, vec2<f32>(0.0), vec2<f32>(size - vec2<u32>(1u)));
    let lo = vec2<u32>(floor(c));
    let hi = min(lo + vec2<u32>(1u), size - vec2<u32>(1u));
    let t = c - vec2<f32>(lo);
    let a = lerp_exact(patch_pixels[lo.y * size.x + lo.x], patch_pixels[lo.y * size.x + hi.x], t.x);
    let b = lerp_exact(patch_pixels[hi.y * size.x + lo.x], patch_pixels[hi.y * size.x + hi.x], t.x);
    return lerp_exact(a, b, t.y);
}

@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) id: vec3<u32>) {
    let i = id.x;
    if i >= params.image_size.x * params.image_size.y { return; }
    let base = src[i];
    let pixel = vec2<u32>(i % params.image_size.x, i / params.image_size.x);
    let uv = params.window.xy + (vec2<f32>(pixel) + vec2<f32>(0.5))
        / vec2<f32>(params.image_size) * params.window.zw;
    if any(uv < params.region.xy) || any(uv >= params.region.xy + params.region.zw) {
        dst[i] = base;
        return;
    }
    let p = clamp((uv - params.region.xy) / params.region.zw, vec2<f32>(0.0), vec2<f32>(1.0))
        * vec2<f32>(params.patch_size) - vec2<f32>(0.5);
    let sampled = sample_patch(p);
    let coverage = clamp(sampled.w, 0.0, 1.0);
    let value = lerp_exact(base, sampled, coverage);
    dst[i] = vec4<f32>(value.xyz, base.w);
}
