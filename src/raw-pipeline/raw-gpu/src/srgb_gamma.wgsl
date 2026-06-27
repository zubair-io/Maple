// srgb_gamma.wgsl — piecewise sRGB gamma (transfer) encode, per IEC 61966-2-1.
//
// A P4a view-tail WGSL port (epic #925 / #992-pre). Ports
// `raw_core::view::encode::srgb_gamma_encode` — the per-channel f32 → f32 sRGB
// OETF that closes the GPU view tail's display-correctness gap. It is the step
// the Auto Profile curve + residual LUT were *fit in* (gamma space), so it must
// run between `display_encode` (rec2020_to_srgb) and `auto_profile_curve`.
//
// Mirrors `raw_core::view::encode::srgb_gamma` applied per channel:
//   x = clamp(x, 0.0, 1.0)                              // BOTH ends
//   x <= 0.0031308 ? x * 12.92 : 1.055 * x^(1/2.4) - 0.055
//
// PARITY-CRITICAL invariants (mirrored verbatim from the Rust stage):
//
// * The clamp is applied FIRST and on BOTH ends (`clamp(0, 1)`), matching
//   `srgb_gamma`'s `x.clamp(0.0, 1.0)`. A one-sided `min(x, 1.0)` would leave
//   negative input → `pow(neg, 1/2.4)` = NaN. After the clamp, the power
//   branch only ever sees non-negative input.
// * The piecewise knee is at 0.0031308 (the IEC threshold, `<=` on the linear
//   side, matching the Rust `if x <= 0.003_130_8`). raw-core uses `x.powf(...)`
//   for the high branch; WGSL `pow` on a clamped-non-negative base matches it.
// * No Oklab, no color matrices — this is a pure per-channel transfer, so the
//   kernel compiles standalone (like exposure / scene_tone_controls), with no
//   `color_matrices.wgsl` concat.
//
// f32 → f32: alpha is carried through untouched. This is NOT the dither/
// quantize-to-u8 step (that is the format-changing display-OUTPUT stage, P4b).

struct Params {
    count: u32,  // number of RGBA pixels
    _pad0: u32,
    _pad1: u32,
    _pad2: u32,
};

@group(0) @binding(0) var<uniform> params: Params;
@group(0) @binding(1) var<storage, read> input_buf: array<vec4<f32>>;
@group(0) @binding(2) var<storage, read_write> output_buf: array<vec4<f32>>;

// Single-channel piecewise sRGB gamma encode. Verbatim mirror of
// raw_core::view::encode::srgb_gamma: clamp to [0, 1] FIRST, then the IEC
// piecewise OETF.
fn srgb_gamma(x: f32) -> f32 {
    let c = clamp(x, 0.0, 1.0);
    if (c <= 0.0031308) {
        return c * 12.92;
    }
    return 1.055 * pow(c, 1.0 / 2.4) - 0.055;
}

@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) gid: vec3<u32>, @builtin(num_workgroups) ng: vec3<u32>) {
    let i = gid.y * ng.x * 64u + gid.x;
    if (i >= params.count) {
        return;
    }
    let px = input_buf[i];
    let out_rgb = vec3<f32>(srgb_gamma(px.r), srgb_gamma(px.g), srgb_gamma(px.b));
    output_buf[i] = vec4<f32>(out_rgb, px.a);
}
