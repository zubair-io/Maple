// auto_profile_curve.wgsl — Auto Profile per-pixel tone CURVE
// (raw_core::view::auto_profile::apply::apply_curve; spec #530 / #550).
//
// A P2 view-transform stage (epic #925 / #990). This is the per-pixel CLOSED-FORM
// curve evaluation ONLY — NOT the residual 3D LUT (that is a later, LUT-template
// wave). The whole `ProfileCurve` is per-image data: three 32-anchor monotone
// piecewise-linear channel curves (only the OUTPUT values vary — inputs are the
// implicit even spacing i/31), an optional 3×3 cross-channel matrix, and a set of
// Oklab corrections (chroma scale, (a,b) offset, an L offset, and two 5-anchor
// L-band correction LUTs). It is uploaded once as a flat f32 STORAGE buffer (the
// analog of white_balance's CPU-derived matrix uniform), keeping the kernel a
// pure per-pixel function.
//
// Parity oracle: raw-gpu::apply_auto_profile_curve (CPU), a line-for-line copy of
// raw_core::view::auto_profile::apply::apply_curve. Parity gate < 1e-4 vs that
// oracle AND vs the real `apply_curve` (see auto_profile_curve/tests.rs).
//
// ## Why the two flags are CPU-computed (parity-critical)
//
// `apply_curve` SKIPS the matrix matmul when the matrix is identity and SKIPS the
// entire Oklab block when every Oklab correction is at its no-op value. The #550
// production fit sets both to identity/zero (AgX owns chroma + cross-channel
// coupling now), so the hot path is the per-channel curve alone. An
// always-on Oklab round-trip would drift ~1e-4 on neutrals (the same reason
// vibrance bit-exact-passes neutrals) and BREACH the gate on the identity path —
// so `apply_chroma` and `identity` are computed CPU-side EXACTLY as Rust computes
// them and passed as u32 flags the kernel branches on. (The identity-matrix
// matmul is itself bit-exact — 1*r+0+0 — so branching on `identity` is belt-and-
// braces; the Oklab skip is the one that is NOT optional.)
//
// ## RGBA-vec4 chain Pass, alpha passthrough (like display_encode)
//
// `apply_curve` operates on a packed `[R,G,B,...]` buffer in raw-core — but that
// is a CPU-view-path detail, not a constraint on the GPU Pass. The `Pass` trait
// in this crate is RGBA-vec4 (the ping-pong chain buffers carry alpha), and every
// view-transform stage here (display_encode) is an RGBA-vec4 Pass that processes
// `.rgb` and writes back `vec4(out, px.a)`. The per-pixel COLOR math is identical
// either way, so parity holds exactly on the RGB lanes; the chain just carries an
// alpha lane apply_curve doesn't have. The parity test extracts count*3 RGB from
// the RGBA input, runs the real `apply_curve` on it, and compares the GPU's RGB
// lanes (alpha checked separately as a passthrough).
//
// ## Color matrices (same concat-at-compile as vibrance)
//
// The generated `color_matrices.wgsl` is prepended to this source at module
// creation (WGSL has no `#include`). It supplies the rec2020↔Oklab `mul_*`
// helpers used by the Oklab correction path. No codegen change — the existing
// rec2020 Oklab pair is exactly what apply_curve uses.

// Flat layout offsets into the curve storage buffer. Mirror
// `ProfileCurve::to_flat` (curve.rs):
//   [0 .. 192)   r/g/b anchors: 3 channels × 32 anchors × (input, output)
//   [192 .. 201) matrix (row-major 3×3)
//   [201]        chroma_boost
//   [202 .. 204) chroma_offset (a, b)
//   [204]        lightness_offset
//   [205 .. 210) lightness_band_offsets[5]
//   [210 .. 220) ab_band_offsets[5] × (a, b)
// = PROFILE_CURVE_FLAT_LEN (220). The flags + pixel count travel in a SEPARATE
// `CurveMeta` uniform (binding 0), NOT appended to this storage buffer.
const ANCHORS: u32 = 32u;
const OFF_MATRIX: u32 = 192u;        // 3*32*2
const OFF_CHROMA_BOOST: u32 = 201u;  // +9 matrix
const OFF_CHROMA_OFFSET: u32 = 202u;
const OFF_LIGHTNESS_OFFSET: u32 = 204u;
const OFF_L_BAND: u32 = 205u;
const OFF_AB_BAND: u32 = 210u;

struct CurveMeta {
    count: u32,        // number of RGBA pixels (dims.0 * dims.1)
    identity: u32,     // 1 = matrix is IDENTITY_MATRIX → skip the matmul
    apply_chroma: u32, // 1 = run the Oklab correction block
    _pad0: u32,
};

// NB: the binding is named `params` (not `meta`) — `meta` is a reserved WGSL
// keyword. The Rust-side struct is `Meta`; only the WGSL identifier matters here.
@group(0) @binding(0) var<uniform> params: CurveMeta;
@group(0) @binding(1) var<storage, read> input_buf: array<vec4<f32>>;        // RGBA
@group(0) @binding(2) var<storage, read_write> output_buf: array<vec4<f32>>; // RGBA
@group(0) @binding(3) var<storage, read> curve: array<f32>;                  // flat ProfileCurve

// Sign-preserving cube root (WGSL has no `cbrt`; `pow(x, 1/3)` is NaN for x<0).
// Mirrors Rust's `f32::cbrt`. Same helper as the vibrance / saturation kernels.
fn cbrt_signed(x: f32) -> f32 {
    return sign(x) * pow(abs(x), 1.0 / 3.0);
}

// Scene/display Rec.2020 → Oklab. Mirrors raw_core::color::oklab::rec2020_to_oklab.
fn rec2020_to_oklab(rgb: vec3<f32>) -> vec3<f32> {
    let srgb = mul_rec2020_to_srgb(rgb);
    let lms = mul_srgb_to_lms(srgb);
    let lms_cube = vec3<f32>(cbrt_signed(lms.x), cbrt_signed(lms.y), cbrt_signed(lms.z));
    return mul_lms_to_lab(lms_cube);
}

// Oklab → Rec.2020. Mirrors raw_core::color::oklab::oklab_to_rec2020.
fn oklab_to_rec2020(lab: vec3<f32>) -> vec3<f32> {
    let lms_cube = mul_lab_to_lms(lab);
    let lms = lms_cube * lms_cube * lms_cube; // cube — sign-preserving by construction
    let srgb = mul_lms_to_srgb(lms);
    return mul_srgb_to_rec2020(srgb);
}

// Soft-knee compression: identity for x ≤ KNEE=0.95, smooth roll-off to
// asymptote 1.0 above. Mirrors raw_core::view::auto_profile::apply::compress_input
// verbatim (negatives clamp to 0 first). Inert in [0, 0.95] display space; only
// bites HDR highlights.
fn compress_input(x_in: f32) -> f32 {
    let x = max(x_in, 0.0);
    let knee = 0.95;
    if (x <= knee) {
        return x;
    }
    let over = (x - knee) / (1.0 - knee);
    return knee + (1.0 - knee) * (over / (1.0 + over));
}

// Evaluate a 32-anchor channel curve at v in [0,1]. Anchors are evenly spaced in
// input, so the fractional anchor index is `v * (ANCHORS-1)` directly — no search.
// Only the OUTPUT values are stored (interleaved as (input, output) in the flat
// buffer); we read output at offset `base + 2*idx + 1`. Mirrors
// raw_core::view::auto_profile::curve::eval_channel.
fn eval_channel(base: u32, v_in: f32) -> f32 {
    let v = clamp(v_in, 0.0, 1.0);
    let scaled = v * f32(ANCHORS - 1u);
    let lo = u32(floor(scaled));
    let hi = min(lo + 1u, ANCHORS - 1u);
    let t = scaled - f32(lo);
    let lo_y = curve[base + 2u * lo + 1u];
    let hi_y = curve[base + 2u * hi + 1u];
    return lo_y + (hi_y - lo_y) * t;
}

@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) gid: vec3<u32>, @builtin(num_workgroups) ng: vec3<u32>) {
    let i = gid.y * ng.x * 64u + gid.x;
    if (i >= params.count) {
        return;
    }
    let px = input_buf[i];
    let r0 = compress_input(px.r);
    let g0 = compress_input(px.g);
    let b0 = compress_input(px.b);

    // Per-channel curve. R anchors start at 0, G at 64 (32×2), B at 128.
    let r1 = eval_channel(0u, r0);
    let g1 = eval_channel(ANCHORS * 2u, g0);
    let b1 = eval_channel(ANCHORS * 4u, b0);

    // Optional cross-channel 3×3 matrix (row-major), applied AFTER the curves.
    // Skipped when identity (the #550 production case). Identity matmul is itself
    // bit-exact, so the branch only mirrors Rust's structure.
    var r2 = r1;
    var g2 = g1;
    var b2 = b1;
    if (params.identity == 0u) {
        let m0 = vec3<f32>(curve[OFF_MATRIX + 0u], curve[OFF_MATRIX + 1u], curve[OFF_MATRIX + 2u]);
        let m1 = vec3<f32>(curve[OFF_MATRIX + 3u], curve[OFF_MATRIX + 4u], curve[OFF_MATRIX + 5u]);
        let m2 = vec3<f32>(curve[OFF_MATRIX + 6u], curve[OFF_MATRIX + 7u], curve[OFF_MATRIX + 8u]);
        let v = vec3<f32>(r1, g1, b1);
        r2 = dot(m0, v);
        g2 = dot(m1, v);
        b2 = dot(m2, v);
    }

    // Optional Oklab correction block. CRITICAL: skipped entirely (NOT a no-op
    // round-trip) when apply_chroma is false — an always-on round-trip drifts
    // ~1e-4 on neutrals and breaches the gate. Mirrors apply_curve's `if
    // apply_chroma` guard exactly; there is deliberately NO near-neutral guard
    // here (apply_curve has none).
    if (params.apply_chroma == 1u) {
        let chroma_boost = curve[OFF_CHROMA_BOOST];
        let chroma_off = vec2<f32>(curve[OFF_CHROMA_OFFSET + 0u], curve[OFF_CHROMA_OFFSET + 1u]);
        let l_off = curve[OFF_LIGHTNESS_OFFSET];

        let lab = rec2020_to_oklab(vec3<f32>(r2, g2, b2));

        // Bin by Rec.709 luma on the post-curve+matrix RGB (matches fit-time
        // binning). 5 anchors at Y = 0/0.25/0.5/0.75/1.0 → scaled = y*4.
        let y_post = clamp(0.2126 * r2 + 0.7152 * g2 + 0.0722 * b2, 0.0, 1.0);
        let scaled_pos = y_post * 4.0;
        let lo = u32(floor(scaled_pos));
        let hi = min(lo + 1u, 4u);
        let t = scaled_pos - f32(lo);

        let band_l_corr = curve[OFF_L_BAND + lo] * (1.0 - t) + curve[OFF_L_BAND + hi] * t;
        let band_a_corr = curve[OFF_AB_BAND + 2u * lo + 0u] * (1.0 - t)
            + curve[OFF_AB_BAND + 2u * hi + 0u] * t;
        let band_b_corr = curve[OFF_AB_BAND + 2u * lo + 1u] * (1.0 - t)
            + curve[OFF_AB_BAND + 2u * hi + 1u] * t;

        let scaled = vec3<f32>(
            lab.x + l_off + band_l_corr,
            lab.y * chroma_boost + chroma_off.x + band_a_corr,
            lab.z * chroma_boost + chroma_off.y + band_b_corr,
        );
        let back = oklab_to_rec2020(scaled);
        r2 = back.x;
        g2 = back.y;
        b2 = back.z;
    }

    // Alpha passed through untouched (apply_curve has no alpha; the chain carries it).
    output_buf[i] = vec4<f32>(r2, g2, b2, px.a);
}
