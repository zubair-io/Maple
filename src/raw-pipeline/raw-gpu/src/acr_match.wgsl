// acr_match.wgsl — AcrMatch view transform (scene-linear Rec.2020 →
// display-linear Rec.2020). GPU slice 2 of epic #1710 / #1722.
//
// Applies the baked AcrMatch 3D scene-linear cube LUT (acr_match_lut.bin:
// ACR_MATCH_LUT_N³ × 3 f32 LE, uploaded to storage binding 3) using the AgX
// log2 shaper + trilinear interpolation. One LUT lookup per pixel (the perf
// contract — no per-pixel model evaluation, no loop).
//
// Layout of the LUT storage buffer:
//   index = ((b * N + g) * N + r) * 3 + channel
// where r/g/b ∈ [0, N-1] are the shaper-encoded axis indices and channel is
// 0=R, 1=G, 2=B.
//
// Shaper: mirrors AgX log2 encode exactly —
//   floor = MID_GRAY * 2^MIN_EV
//   t[c] = (log2(max(v, floor) / MID_GRAY) − MIN_EV) / (MAX_EV − MIN_EV)
// These constants are INLINED (not from generated/agx_coeffs.wgsl) so the
// kernel compiles standalone with no generated-header concat. The values are
// single-sourced from raw_core::view::acr_match.

struct Params {
    count: u32,      // number of RGBA pixels
    size:  u32,      // LUT node count per axis (ACR_MATCH_LUT_N)
    _pad0: u32,
    _pad1: u32,
};

@group(0) @binding(0) var<uniform>           params:     Params;
@group(0) @binding(1) var<storage, read>     input_buf:  array<vec4<f32>>;
@group(0) @binding(2) var<storage, read_write> output_buf: array<vec4<f32>>;
// The baked AcrMatch LUT (ACR_MATCH_LUT_N³ × 3 f32). Read-only storage
// (4-byte stride) — a uniform array<f32> would silently get a 16-byte stride.
@group(0) @binding(3) var<storage, read>     acr_lut:    array<f32>;

// Shaper constants — single-sourced from raw_core::view::acr_match.
const ACR_MIN_EV:  f32 = -10.0;
const ACR_MAX_EV:  f32 =   6.5;
const ACR_MID:     f32 =   0.18;

// Encode one scene-linear channel to the [0, 1] shaper domain.
// Mirrors `raw_core::view::acr_match::lut_encode`.
fn acr_lut_encode(v: f32) -> f32 {
    let floor_v = ACR_MID * exp2(ACR_MIN_EV);
    let c = max(v, floor_v);
    let log_v = clamp(log2(c / ACR_MID), ACR_MIN_EV, ACR_MAX_EV);
    return (log_v - ACR_MIN_EV) / (ACR_MAX_EV - ACR_MIN_EV);
}

// Read one RGB node at (r, g, b) from the flat storage buffer.
// index = ((b * N + g) * N + r) * 3
fn lut_node(r: u32, g: u32, b: u32) -> vec3<f32> {
    let n = params.size;
    let base = ((b * n + g) * n + r) * 3u;
    return vec3<f32>(acr_lut[base], acr_lut[base + 1u], acr_lut[base + 2u]);
}

// Trilinear sample the 3D LUT at shaper-encoded position (tr, tg, tb) ∈ [0,1].
// Mirrors `raw_core::view::acr_match::sample_lut_3d`.
fn acr_lut_sample(scene: vec3<f32>) -> vec3<f32> {
    let n = params.size;
    let last = f32(n - 1u);

    let tr = acr_lut_encode(scene.x);
    let tg = acr_lut_encode(scene.y);
    let tb = acr_lut_encode(scene.z);

    let pr = clamp(tr, 0.0, 1.0) * last;
    let pg = clamp(tg, 0.0, 1.0) * last;
    let pb = clamp(tb, 0.0, 1.0) * last;

    let r0 = u32(min(floor(pr), last - 1.0));
    let g0 = u32(min(floor(pg), last - 1.0));
    let b0 = u32(min(floor(pb), last - 1.0));
    let r1 = r0 + 1u;
    let g1 = g0 + 1u;
    let b1 = b0 + 1u;

    let fr = pr - floor(pr);
    let fg = pg - floor(pg);
    let fb = pb - floor(pb);

    // Trilinear interpolation.
    let c000 = lut_node(r0, g0, b0);
    let c100 = lut_node(r1, g0, b0);
    let c010 = lut_node(r0, g1, b0);
    let c110 = lut_node(r1, g1, b0);
    let c001 = lut_node(r0, g0, b1);
    let c101 = lut_node(r1, g0, b1);
    let c011 = lut_node(r0, g1, b1);
    let c111 = lut_node(r1, g1, b1);

    let c00 = mix(c000, c100, fr);
    let c10 = mix(c010, c110, fr);
    let c01 = mix(c001, c101, fr);
    let c11 = mix(c011, c111, fr);
    let c0  = mix(c00,  c10,  fg);
    let c1  = mix(c01,  c11,  fg);
    return mix(c0, c1, fb);
}

@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) gid: vec3<u32>, @builtin(num_workgroups) ng: vec3<u32>) {
    let i = gid.y * ng.x * 64u + gid.x;
    if (i >= params.count) {
        return;
    }
    let px = input_buf[i];

    // One LUT sample per pixel (the perf contract). Alpha is carried through.
    let display = acr_lut_sample(px.rgb);

    output_buf[i] = vec4<f32>(display, px.a);
}
