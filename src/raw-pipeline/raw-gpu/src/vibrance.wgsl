// vibrance.wgsl — Oklab vibrance with skin-tone protection (raw-core spec § 3.7).
//
// The P2 template kernel (epic #925 / #990): the first GPU stage that rounds a
// pixel through Oklab, so it establishes the two primitives every downstream
// Oklab/matrix stage reuses — a row-major 3×3 matrix multiply and a
// sign-preserving cube root.
//
// Parity oracle: raw-gpu::apply_vibrance (CPU), which is a line-for-line copy of
// raw-core::stages::vibrance::apply. Parity gate < 1e-4 vs that oracle.
//
// ## How the color matrices get here
//
// WGSL has no `#include`. The generated color-matrix module
// (`generated/color_matrices.wgsl`, emitted by `codegen --schema
// color-matrices --target wgsl`) is concatenated *ahead* of this source at
// shader-module creation (see `context.rs::vibrance_pipeline`). That module
// defines the `mul_*` helpers used below:
//   mul_rec2020_to_srgb / mul_srgb_to_lms / mul_lms_to_lab   (forward)
//   mul_lab_to_lms / mul_lms_to_srgb / mul_srgb_to_rec2020   (inverse)
// Each is `vec3(dot(R0,v), dot(R1,v), dot(R2,v))` — row-major, matching
// raw-core::math::Matrix3::mul_vec exactly (NOT a column-major `mat3x3 * v`,
// which would silently transpose and break parity).

struct Params {
    amount: f32,  // vibrance / 100.0
    count: u32,   // number of RGBA pixels
    _pad0: u32,
    _pad1: u32,
};

@group(0) @binding(0) var<uniform> params: Params;
@group(0) @binding(1) var<storage, read> input_buf: array<vec4<f32>>;
@group(0) @binding(2) var<storage, read_write> output_buf: array<vec4<f32>>;

// Sign-preserving cube root. WGSL has no `cbrt`, and `pow(x, 1/3)` is NaN for
// x < 0. raw-core's Oklab path explicitly tolerates slightly-negative LMS
// (scene-referred values out of DCP), so we mirror Rust's `f32::cbrt`, which is
// sign-preserving: cbrt(-x) == -cbrt(x).
fn cbrt_signed(x: f32) -> f32 {
    return sign(x) * pow(abs(x), 1.0 / 3.0);
}

// Scene-linear Rec.2020 D65 → Oklab. Mirrors raw-core::color::oklab::rec2020_to_oklab.
fn rec2020_to_oklab(rgb: vec3<f32>) -> vec3<f32> {
    let srgb = mul_rec2020_to_srgb(rgb);
    let lms = mul_srgb_to_lms(srgb);
    let lms_cube = vec3<f32>(cbrt_signed(lms.x), cbrt_signed(lms.y), cbrt_signed(lms.z));
    return mul_lms_to_lab(lms_cube);
}

// Oklab → scene-linear Rec.2020 D65. Mirrors raw-core::color::oklab::oklab_to_rec2020.
fn oklab_to_rec2020(lab: vec3<f32>) -> vec3<f32> {
    let lms_cube = mul_lab_to_lms(lab);
    let lms = lms_cube * lms_cube * lms_cube; // cube — sign-preserving by construction
    let srgb = mul_lms_to_srgb(lms);
    return mul_srgb_to_rec2020(srgb);
}

@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) gid: vec3<u32>, @builtin(num_workgroups) ng: vec3<u32>) {
    let i = gid.y * ng.x * 64u + gid.x;
    if (i >= params.count) {
        return;
    }
    let px = input_buf[i];
    let rgb = px.rgb;

    let lab = rec2020_to_oklab(rgb);
    let l = lab.x;
    let a = lab.y;
    let b = lab.z;
    let chroma = sqrt(a * a + b * b);

    // Near-neutral pixel: nothing meaningful to scale. Pass the ORIGINAL rgb
    // through bit-exact — NOT an Oklab round-trip, which would drift ~1e-4 on
    // neutrals and break the gate. Mirrors the Rust `continue`.
    //
    // FAN-OUT NOTE: this guard is NaN-SAFETY, not just an optimization. At
    // exact zero chroma `atan2(b, a) == atan2(0, 0)` is undefined in WGSL, so a
    // true neutral that skipped this branch could produce `scale = NaN` and a
    // NaN output pixel. Every Oklab fan-out stage (saturation especially) needs
    // the same near-neutral guard for the same reason — keep it.
    if (chroma < 1e-6) {
        output_buf[i] = px;
        return;
    }

    let hue_deg = atan2(b, a) * 180.0 / 3.14159265358979323846;
    let skin_mask = smoothstep(15.0, 22.0, hue_deg) * (1.0 - smoothstep(35.0, 42.0, hue_deg));
    let low_chroma_factor = 1.0 - min(chroma / 0.3, 1.0);
    let chroma_boost = low_chroma_factor * params.amount * (1.0 - skin_mask * 0.6);
    let scale = 1.0 + chroma_boost;

    let new_lab = vec3<f32>(l, a * scale, b * scale);
    let out_rgb = oklab_to_rec2020(new_lab);
    output_buf[i] = vec4<f32>(out_rgb, px.a);
}
