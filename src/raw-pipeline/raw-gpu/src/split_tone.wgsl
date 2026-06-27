// split_tone.wgsl — display-linear Oklab split toning (#1111, tone/zoom
// design § 10.3; raw_core::stages::split_tone::apply).
//
// Runs POST-AgX, before grain / display_encode. Per pixel: compute the
// display luminance, derive the balance-shifted shadow/highlight weights,
// and add the pre-scaled hue vectors to Oklab (a, b) — L untouched, so
// tone is invariant. The weight exponents + hue vectors are hoisted
// host-side with the SAME float sequence as raw-core's
// `split_tone_params` (the parity test pins both to the real stage).
//
// The shift can leave the sRGB hull; the downstream display_encode Oklab
// gamut compression owns bringing it back (nothing clips here).
//
// Needs the generated color matrices (rec2020 ↔ Oklab round-trip), so the
// module is compiled with `compile_with_matrices` — same concat pattern
// as vibrance / saturation.

struct Params {
    gamma: f32,      // exp2(balance / 100)
    inv_gamma: f32,  // 1 / gamma
    s_a: f32,        // K · sS/100 · cos(hS)
    s_b: f32,        // K · sS/100 · sin(hS)
    h_a: f32,        // K · sH/100 · cos(hH)
    h_b: f32,        // K · sH/100 · sin(hH)
    count: u32,      // number of RGBA pixels
    _pad0: u32,
};

@group(0) @binding(0) var<uniform> params: Params;
@group(0) @binding(1) var<storage, read> input_buf: array<vec4<f32>>;
@group(0) @binding(2) var<storage, read_write> output_buf: array<vec4<f32>>;

// Rec.2020 luma weights (the pipeline-wide constant).
const LUMA_R: f32 = 0.2627;
const LUMA_G: f32 = 0.6780;
const LUMA_B: f32 = 0.0593;

// Sign-preserving cube root (same helper as the vibrance/saturation kernels).
fn cbrt_signed(x: f32) -> f32 {
    return sign(x) * pow(abs(x), 1.0 / 3.0);
}

// Display-linear Rec.2020 → Oklab. Mirrors raw_core::color::oklab.
fn rec2020_to_oklab(rgb: vec3<f32>) -> vec3<f32> {
    let srgb = mul_rec2020_to_srgb(rgb);
    let lms = mul_srgb_to_lms(srgb);
    let lms_cube = vec3<f32>(cbrt_signed(lms.x), cbrt_signed(lms.y), cbrt_signed(lms.z));
    return mul_lms_to_lab(lms_cube);
}

// Oklab → display-linear Rec.2020. Mirrors raw_core::color::oklab.
fn oklab_to_rec2020(lab: vec3<f32>) -> vec3<f32> {
    let lms_cube = mul_lab_to_lms(lab);
    let lms = lms_cube * lms_cube * lms_cube;
    let srgb = mul_lms_to_srgb(lms);
    return mul_srgb_to_rec2020(srgb);
}

@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) gid: vec3<u32>, @builtin(num_workgroups) ng: vec3<u32>) {
    let i = gid.y * ng.x * 64u + gid.x;
    if (i >= params.count) {
        return;
    }
    let p = input_buf[i];

    // Balance-shifted weights at the pixel's display luminance — mirrors
    // raw-core's `split_tone_shift` float sequence.
    let yd = clamp(LUMA_R * p.r + LUMA_G * p.g + LUMA_B * p.b, 0.0, 1.0);
    let ws = pow(1.0 - yd, params.gamma);
    let wh = pow(yd, params.inv_gamma);
    let da = ws * params.s_a + wh * params.h_a;
    let db = ws * params.s_b + wh * params.h_b;

    let lab = rec2020_to_oklab(p.rgb);
    let out_rgb = oklab_to_rec2020(vec3<f32>(lab.x, lab.y + da, lab.z + db));
    output_buf[i] = vec4<f32>(out_rgb, p.a);
}
