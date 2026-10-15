// #4629: exact stage order/math of raw-core::color::hsm::apply_one.
// The table is already interpolated between its calibration illuminants.
// Generated color_matrices.wgsl supplies the core's HSM guard constants.
struct Params {
    dims: vec3<u32>,
    count: u32,
    srgb: u32,
    _pad0: u32,
    _pad1: u32,
    _pad2: u32,
};
@group(0) @binding(0) var<uniform> params: Params;
@group(0) @binding(1) var<storage, read> input_buf: array<vec4<f32>>;
@group(0) @binding(2) var<storage, read_write> output_buf: array<vec4<f32>>;
@group(0) @binding(3) var<storage, read> table: array<f32>;

fn wrap(v: f32, period: f32) -> f32 {
    let r = v % period;
    return select(r, r + period, r < 0.0);
}

fn encode_srgb(v: f32) -> f32 {
    let x = max(v, 0.0);
    if (x <= 0.0031308) { return 12.92 * x; }
    return 1.055 * pow(x, 1.0 / 2.4) - 0.055;
}

fn decode_srgb(v: f32) -> f32 {
    if (v <= 0.04045) { return v / 12.92; }
    return pow((v + 0.055) / 1.055, 2.4);
}

fn rgb_to_hsv(rgb: vec3<f32>) -> vec3<f32> {
    let hi = max(max(rgb.r, rgb.g), rgb.b);
    let lo = min(min(rgb.r, rgb.g), rgb.b);
    let delta = hi - lo;
    var s = 0.0;
    if (hi > 0.0) { s = delta / hi; }
    var h = 0.0;
    if (s > 0.0 && delta >= HSM_HSV_DELTA_EPSILON) {
        if (abs(hi - rgb.r) < HSM_HSV_DELTA_EPSILON) {
            h = 60.0 * wrap((rgb.g - rgb.b) / delta, 6.0);
        } else if (abs(hi - rgb.g) < HSM_HSV_DELTA_EPSILON) {
            h = 60.0 * (((rgb.b - rgb.r) / delta) + 2.0);
        } else {
            h = 60.0 * (((rgb.r - rgb.g) / delta) + 4.0);
        }
    }
    if (h < 0.0) { h += 360.0; }
    else if (h >= 360.0) { h -= 360.0; }
    return vec3<f32>(h, s, hi);
}

fn hsv_to_rgb(hue: f32, s: f32, v: f32) -> vec3<f32> {
    if (s <= 0.0) { return vec3<f32>(v); }
    let h = wrap(hue, 360.0) / 60.0;
    let c = v * s;
    let x = c * (1.0 - abs((h % 2.0) - 1.0));
    var rgb: vec3<f32>;
    if (h < 1.0) { rgb = vec3<f32>(c, x, 0.0); }
    else if (h < 2.0) { rgb = vec3<f32>(x, c, 0.0); }
    else if (h < 3.0) { rgb = vec3<f32>(0.0, c, x); }
    else if (h < 4.0) { rgb = vec3<f32>(0.0, x, c); }
    else if (h < 5.0) { rgb = vec3<f32>(x, 0.0, c); }
    else { rgb = vec3<f32>(c, 0.0, x); }
    return rgb + vec3<f32>(v - c);
}

fn entry(h: u32, s: u32, v: u32) -> vec3<f32> {
    let i = ((h * params.dims.y + s) * params.dims.z + v) * 3u;
    return vec3<f32>(table[i], table[i + 1u], table[i + 2u]);
}

fn unwrap_entry(v: vec3<f32>, anchor: f32) -> vec3<f32> {
    var delta = v.x - anchor;
    if (delta > 180.0) { delta -= 360.0; }
    if (delta < -180.0) { delta += 360.0; }
    return vec3<f32>(anchor + delta, v.yz);
}

fn interpolate(a: vec3<f32>, b: vec3<f32>, t: f32) -> vec3<f32> {
    // Difference form preserves a constant signed half-turn exactly, so
    // roundoff cannot reverse the achromatic fade. Match the CPU per channel.
    return vec3<f32>(a.x + (b.x - a.x) * t, a.yz * (1.0 - t) + b.yz * t);
}

fn lookup(hsv: vec3<f32>) -> vec3<f32> {
    let p = vec3<f32>(
        (hsv.x / 360.0) * f32(params.dims.x),
        clamp(hsv.y, 0.0, 1.0) * f32(params.dims.y - 1u),
        clamp(hsv.z, 0.0, 1.0) * f32(params.dims.z - 1u),
    );
    let lo = vec3<u32>(floor(p));
    let f = p - floor(p);
    let h0 = lo.x % params.dims.x;
    let h1 = (lo.x + 1u) % params.dims.x;
    let s0 = min(lo.y, params.dims.y - 1u);
    let s1 = min(lo.y + 1u, params.dims.y - 1u);
    let v0 = min(lo.z, params.dims.z - 1u);
    let v1 = min(lo.z + 1u, params.dims.z - 1u);
    let c000 = entry(h0, s0, v0);
    let c100 = unwrap_entry(entry(h1, s0, v0), c000.x);
    let c010 = unwrap_entry(entry(h0, s1, v0), c000.x);
    let c110 = unwrap_entry(entry(h1, s1, v0), c000.x);
    let c001 = unwrap_entry(entry(h0, s0, v1), c000.x);
    let c101 = unwrap_entry(entry(h1, s0, v1), c000.x);
    let c011 = unwrap_entry(entry(h0, s1, v1), c000.x);
    let c111 = unwrap_entry(entry(h1, s1, v1), c000.x);
    // Preserve the CPU's axis order, including signed half-turn endpoints.
    let lo0 = interpolate(c000, c100, f.x);
    let lo1 = interpolate(c010, c110, f.x);
    let hi0 = interpolate(c001, c101, f.x);
    let hi1 = interpolate(c011, c111, f.x);
    let low = interpolate(lo0, lo1, f.y);
    let high = interpolate(hi0, hi1, f.y);
    let result = interpolate(low, high, f.z);
    let m = result.x % 360.0;
    var hue = m;
    if (m > 180.0) { hue -= 360.0; }
    else if (m < -180.0) { hue += 360.0; }
    return vec3<f32>(hue, result.yz);
}

@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) gid: vec3<u32>, @builtin(num_workgroups) ng: vec3<u32>) {
    let i = gid.y * ng.x * 64u + gid.x;
    if (i >= params.count) { return; }
    let pixel = input_buf[i];
    let lift = max(-min(min(pixel.r, pixel.g), pixel.b), 0.0);
    var rgb = pixel.rgb + vec3<f32>(lift);
    if (params.srgb != 0u) {
        rgb = vec3<f32>(encode_srgb(rgb.r), encode_srgb(rgb.g), encode_srgb(rgb.b));
    }
    let hsv = rgb_to_hsv(rgb);
    let adjustment = lookup(hsv);
    let weight = clamp(hsv.y / HSM_ACHROMATIC_SATURATION, 0.0, 1.0);
    let hd = adjustment.x * weight;
    let ss = 1.0 + (adjustment.y - 1.0) * weight;
    let vs = 1.0 + (adjustment.z - 1.0) * weight;
    var out = hsv_to_rgb(wrap(hsv.x + hd, 360.0), clamp(hsv.y * ss, 0.0, 1.0), max(hsv.z * vs, 0.0));
    if (params.srgb != 0u) {
        out = vec3<f32>(decode_srgb(out.r), decode_srgb(out.g), decode_srgb(out.b));
    }
    output_buf[i] = vec4<f32>(out - vec3<f32>(lift), pixel.a);
}
