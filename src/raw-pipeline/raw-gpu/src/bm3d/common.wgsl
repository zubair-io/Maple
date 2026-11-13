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
// Twins of raw-core `bm3d/exact.rs`: 12-bit halves make every partial
// product exact, so single- and double-rounding `fma` agree across backends.
// `fma` also keeps fast-math compilers from reassociating the sums.
fn split(x: f32) -> vec2<f32> {
    let hi = bitcast<f32>(bitcast<u32>(x) & 0xfffff000u);
    return vec2<f32>(hi, x - hi);
}
// Mesa NIR factors `fma(a, b, fma(a, c, d))` into `fma(a, b + c, d)`, which
// folds the halves back together. XOR with a uniform zero gives each product
// its own operands, which no compiler can prove equal.
fn opaque(x: f32) -> f32 {
    return bitcast<f32>(bitcast<u32>(x) ^ bitcast<u32>(p.highpass.w));
}
fn exact_mul_add(a: f32, b: f32, acc: f32) -> f32 {
    let s = split(a);
    let t = split(b);
    let hi_lo = fma(opaque(s.x), t.y, fma(s.x, t.x, acc));
    return fma(opaque(s.y), opaque(t.y), fma(s.y, opaque(t.x), hi_lo));
}
fn exact_square_add(d: f32, acc: f32) -> f32 {
    let s = split(d);
    let lo = opaque(s.y);
    return fma(s.y, s.y, fma(opaque(s.x), lo + lo, fma(s.x, s.x, acc)));
}
fn luminance(rgb: vec3<f32>) -> f32 {
    let blue = exact_mul_add(p.luma.z, rgb.z, 0.0);
    return exact_mul_add(p.luma.x, rgb.x, exact_mul_add(p.luma.y, rgb.y, blue));
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
