// color_grade.wgsl — display-linear Oklab three-zone colour grading
// (#275; raw_core::stages::color_grade::apply).
//
// Runs POST-AgX, before grain / display_encode. Per pixel: compute the
// display luminance, derive the balance-warped shadow/midtone/highlight
// smoothstep weights, and add the per-wheel Oklab (Δa, Δb, ΔL) offsets —
// plus the unweighted global wheel. The balance exponent and the four
// pre-scaled wheel offsets are hoisted host-side with the SAME float
// sequence as raw-core's `color_grade_params` (the parity test pins both
// to the real stage).
//
// The chroma shift can leave the sRGB hull; the downstream display_encode
// Oklab gamut compression owns bringing it back (nothing clips here). L
// is clamped to [0, 1] — a display-range guard, post view transform.
//
// Needs the generated color matrices (rec2020 ↔ Oklab round-trip), so the
// module is compiled with `compile_with_matrices` — same concat pattern
// as vibrance / saturation.

struct Params {
    // vec4 lanes so the uniform's std140 layout is unambiguous: xyz carry
    // the wheel's (Δa, Δb, ΔL) at unit weight, w is unused padding.
    shadow: vec4<f32>,
    midtone: vec4<f32>,
    highlight: vec4<f32>,
    global: vec4<f32>,
    balance_exp: f32,   // exp2(-balance / 100)
    count: u32,         // number of RGBA pixels
    _pad0: u32,
    _pad1: u32,
};

@group(0) @binding(0) var<uniform> params: Params;
@group(0) @binding(1) var<storage, read> input_buf: array<vec4<f32>>;
@group(0) @binding(2) var<storage, read_write> output_buf: array<vec4<f32>>;

// Oklab L of display-linear mid-grey — the midtone zone's anchor.
// Verbatim from raw_core::stages::color_grade::MIDTONE_ANCHOR_L; the
// headless parity test pins the kernel to that stage, so a drift here
// fails the gate rather than silently diverging the live path.
const MIDTONE_ANCHOR_L: f32 = 0.564622;

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
    let lab = rec2020_to_oklab(p.rgb);

    // Balance-warped zone weights at the pixel's PRE-shift Oklab lightness
    // — mirrors raw-core's `zone_weights` float sequence. An exact
    // partition of unity, C¹ at both hand-offs.
    let l = clamp(lab.x, 0.0, 1.0);
    let lb = pow(l, params.balance_exp);
    let ws = 1.0 - smoothstep(0.0, MIDTONE_ANCHOR_L, lb);
    let wh = smoothstep(MIDTONE_ANCHOR_L, 1.0, lb);
    let wm = 1.0 - ws - wh;

    let shift = params.global.xyz
        + ws * params.shadow.xyz
        + wm * params.midtone.xyz
        + wh * params.highlight.xyz;

    let graded = vec3<f32>(
        clamp(lab.x + shift.z, 0.0, 1.0),
        lab.y + shift.x,
        lab.z + shift.y,
    );
    output_buf[i] = vec4<f32>(oklab_to_rec2020(graded), p.a);
}
