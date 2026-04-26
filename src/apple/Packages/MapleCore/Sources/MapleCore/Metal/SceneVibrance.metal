// SceneVibrance.metal — Oklab-based vibrance with skin-tone protection
// (spec § 3.7). Mirrors vibrance.rs.
//
// Oklab conversion for Rec.2020:
//   - Transform to LMS via M_rec2020_to_lms matrix
//   - Non-linear LMS^(1/3)
//   - L*a*b via M_lms_to_oklab matrix
//
// The skin-tone window is the hue range [15°, 42°] in Oklab with 60%
// attenuation (same as Rust spec values).

#include <CoreImage/CoreImage.h>

// Oklab matrices — bit-for-bit equivalent to Rust's canonical chain in
// `src/raw-pipeline/raw-core/src/color/oklab.rs`:
//
//   rec2020 -> sRGB (M_REC2020_TO_SRGB)
//           -> LMS  (M1_SRGB_TO_LMS, Bottosson 2020)
//           -> cbrt
//           -> Oklab (M2_LMS_TO_LAB, Bottosson 2020)
//
// `M_rec2020_to_lms` is the precomputed product
// `M1_SRGB_TO_LMS @ M_REC2020_TO_SRGB`; `M_lms_to_rec2020` is the
// precomputed product `M_REC2020_TO_SRGB^-1 @ M1_SRGB_TO_LMS^-1`.
// Both computed in float64 numpy from the Rust source-of-truth matrices
// (matrices.rs / oklab.rs), rounded to 8 significant digits.
//
// Replaces the previous Bradford-style direct rec2020->LMS triple that
// did NOT route via sRGB and disagreed with Rust on low-chroma hue
// direction (Ticket 12 follow-up to Bug 2). Rust's `oklab.rs` is the
// single source of truth — do not edit these in isolation.
//
// TODO codegen: lift these four matrices + the WebGL/Rust copies into
// `src/scripts/codegen/` once that scaffold lands. Today there is no
// codegen directory, so all three platforms hold the same constants
// by hand. Same TODO mirrored in SceneSaturation/NRColor/NRLuminance.metal
// and the GLSL shaders.
//
// Each `float3` argument to `float3x3(...)` becomes a COLUMN of the
// resulting Metal matrix, but the values below are the ROWS of the
// math matrix (matching the Rust source's row-major layout). Using
// `v * M_metal` therefore produces `M_math * v` — see SceneSaturation
// header for the full Bug 2 / Ticket 12 explanation.

// M_rec2020_to_lms = M1_SRGB_TO_LMS @ M_REC2020_TO_SRGB.
constant float3x3 M_rec2020_to_lms = float3x3(
    float3( 0.61673040,  0.36021433,  0.02309135),
    float3( 0.26509597,  0.63584589,  0.09906860),
    float3( 0.10005846,  0.20389689,  0.69599049)
);

// M_lms_to_oklab = M2_LMS_TO_LAB (Bottosson 2020). Bit-identical to
// Rust; preserved at the high-precision Bottosson reference values.
constant float3x3 M_lms_to_oklab = float3x3(
    float3(0.2104542553, 0.7936177850, -0.0040720468),
    float3(1.9779984951, -2.4285922050, 0.4505937099),
    float3(0.0259040371, 0.7827717662, -0.8086757660)
);

// M_oklab_to_lms = inverse(M2_LMS_TO_LAB).
constant float3x3 M_oklab_to_lms = float3x3(
    float3(1.0000000000, 0.3963377774, 0.2158037573),
    float3(1.0000000000, -0.1055613458, -0.0638541728),
    float3(1.0000000000, -0.0894841775, -1.2914855480)
);

// M_lms_to_rec2020 = inverse(M_REC2020_TO_SRGB) @ inverse(M1_SRGB_TO_LMS).
constant float3x3 M_lms_to_rec2020 = float3x3(
    float3( 2.13995843, -1.24643838,  0.10642154),
    float3(-0.88463381,  2.16319054, -0.27856253),
    float3(-0.04848752, -0.45453369,  1.50310914)
);

float3 rec2020_to_oklab(float3 rgb) {
    float3 lms = rgb * M_rec2020_to_lms;
    float3 lms_nl = sign(lms) * pow(abs(lms), float3(1.0 / 3.0));
    return lms_nl * M_lms_to_oklab;
}

float3 oklab_to_rec2020(float3 lab) {
    float3 lms_nl = lab * M_oklab_to_lms;
    float3 lms = lms_nl * lms_nl * lms_nl;
    return lms * M_lms_to_rec2020;
}

float smoothstep_v(float e0, float e1, float x) {
    float t = clamp((x - e0) / (e1 - e0), 0.0, 1.0);
    return t * t * (3.0 - 2.0 * t);
}

[[stitchable]] float4 sceneVibrance(
    coreimage::sampler_h src,
    float vibrance   // -100..+100
) {
    float4 color = float4(src.sample(src.coord()));

    if (abs(vibrance) < 1e-3) return color;

    float amount = vibrance / 100.0;
    float3 lab = rec2020_to_oklab(color.rgb);
    float L = lab[0], a = lab[1], b = lab[2];
    float chroma = sqrt(a * a + b * b);

    if (chroma < 1e-6) return color; // near-neutral, nothing to do

    float hue_deg = atan2(b, a) * (180.0 / M_PI_F);
    float skin_mask = smoothstep_v(15.0, 22.0, hue_deg)
                    * (1.0 - smoothstep_v(35.0, 42.0, hue_deg));
    float low_chroma_factor = 1.0 - clamp(chroma / 0.3, 0.0, 1.0);
    float chroma_boost = low_chroma_factor * amount * (1.0 - skin_mask * 0.6);
    float scale = 1.0 + chroma_boost;

    float3 new_lab = float3(L, a * scale, b * scale);
    float3 rgb_out = oklab_to_rec2020(new_lab);
    return float4(rgb_out, color.a);
}
