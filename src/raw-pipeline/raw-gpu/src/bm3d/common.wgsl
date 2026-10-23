// Fixed 8x8 / <=16-member BM3D shape; tuning and DCT basis come from raw-core.
struct Params {
    dims: vec4<u32>,
    control: vec4<u32>,
    scale: vec4<f32>,
    extra: vec4<f32>,
    sort: vec4<u32>,
    luma: vec4<f32>,
    highpass: vec4<f32>,
    basis: array<vec4<f32>, 16>,
    batch: vec4<u32>,
    cache: vec4<u32>,
    stream: vec4<u32>,
};
@group(0) @binding(0) var<uniform> p: Params;
fn index(id: vec3<u32>) -> u32 { return id.x + id.y * 65535u * 64u; }
fn group_index(id: vec3<u32>) -> u32 { return id.x + id.y * 65535u; }
fn luminance(rgb: vec3<f32>) -> f32 {
    return fma(p.luma.x, rgb.x, fma(p.luma.y, rgb.y, p.luma.z * rgb.z));
}
fn opponent(rgb: vec3<f32>, channel: u32) -> f32 {
    let y = luminance(rgb);
    if channel == 0u { return y; }
    if channel == 1u { return rgb.r - y; }
    return rgb.b - y;
}
fn ref_xy(g: u32) -> vec2<u32> {
    return min(vec2<u32>(g % p.dims.z, g / p.dims.z) * p.sort.w, p.dims.xy - vec2<u32>(8u));
}

// Match coordinates use a power-of-two row pitch. Hot per-pixel gathering
// decodes these with shifts instead of repeated integer division by width.
fn pack_patch(xy:vec2<u32>)->u32 { return (xy.y<<p.sort.y)|xy.x; }
fn unpack_patch(position:u32)->vec2<u32> { return vec2<u32>(position&((1u<<p.sort.y)-1u),position>>p.sort.y); }
