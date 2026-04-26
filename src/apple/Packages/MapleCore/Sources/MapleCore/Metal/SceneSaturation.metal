// SceneSaturation.metal — CIColorKernel that mirrors the Rust
// saturation.rs stage (spec § 3.7).
//
// Input: scene-linear Rec.2020 pixel.
// Parameter: saturation in [-100, +100]. 0 -> identity. -100 -> fully
// achromatic. +100 -> 2x chroma. No skin-tone protection (vibrance
// has it; saturation is meant to be uniform).

#include <CoreImage/CoreImage.h>

// Oklab matrices -- bit-for-bit equivalent to the Rust canonical chain
// in `src/raw-pipeline/raw-core/src/color/oklab.rs`:
//
//   rec2020 -> sRGB (M_REC2020_TO_SRGB)
//           -> LMS  (M1_SRGB_TO_LMS, Bottosson 2020)
//           -> cbrt
//           -> Oklab (M2_LMS_TO_LAB, Bottosson 2020)
//
// `M_rec2020_to_lms_sat` is the precomputed product
// `M1_SRGB_TO_LMS @ M_REC2020_TO_SRGB`; `M_lms_to_rec2020_sat` is the
// precomputed product `M_REC2020_TO_SRGB^-1 @ M1_SRGB_TO_LMS^-1`.
// Both were computed in float64 numpy from the Rust source-of-truth
// matrices (constants in matrices.rs / oklab.rs) and rounded to 8
// significant digits, matching the precision style of the original
// constants. M2_LMS_TO_LAB and its inverse are the Bottosson-published
// values, identical bit pattern to Rust.
//
// Replaces the previous Bradford-style direct rec2020->LMS triple that
// did NOT route via sRGB and disagreed with Rust on low-chroma hue
// direction (Ticket 12 follow-up to Bug 2). Rust's `oklab.rs` is the
// single source of truth — do not edit these in isolation.
//
// TODO codegen: lift these four matrices + the WebGL/Rust copies into
// `src/scripts/codegen/` once that scaffold lands. Today there is no
// codegen directory, so all three platforms hold the same constants by
// hand. Same TODO mirrored in SceneVibrance/NRColor/NRLuminance.metal
// and the GLSL shaders.
//
// Repeated per-file with the `_sat` suffix because Metal does not share
// constants between .metal files inside a single metallib; the suffix
// avoids cross-file symbol-resolution ambiguity. If any of these
// matrices change, all four .metal files (Saturation/Vibrance/NRColor/
// NRLuminance) and the WebGL `scene-saturation.ts` / `scene-vibrance.ts`
// shaders MUST be updated together.
//
// IMPORTANT: each `float3` argument to `float3x3(...)` becomes a
// COLUMN of the resulting Metal matrix. The values below are the ROWS
// of the math matrix (matching how the Rust source writes them in
// row-major order). To compute the standard matrix-vector product
// `M_math * v` we therefore use `v * M_metal`, which is equivalent
// to `transpose(M_metal) * v`. The earlier `M_metal * v` form was
// computing `transpose(M_math) * v` and produced nonsense outputs
// (R≈5.4, G≈-2.0 on a fully-desaturated red) once the kernels actually
// started running. See Bug 2 / Ticket 12 for the cast-side companion
// fix that made this latent matrix-orientation bug visible.
// M_rec2020_to_lms_sat = M1_SRGB_TO_LMS @ M_REC2020_TO_SRGB (numpy float64,
// rounded to 8 sig figs). Each `float3` is a ROW of the math matrix.
constant float3x3 M_rec2020_to_lms_sat = float3x3(
    float3( 0.61673040,  0.36021433,  0.02309135),
    float3( 0.26509597,  0.63584589,  0.09906860),
    float3( 0.10005846,  0.20389689,  0.69599049)
);

// M_lms_to_oklab_sat = M2_LMS_TO_LAB (Bottosson 2020). Bit-identical
// to Rust's `M2_LMS_TO_LAB` in oklab.rs; high-precision values from the
// Bottosson reference are preserved as-is (Rust truncates to 8 sig figs
// in source but rounds to the same f32). Each `float3` is a ROW.
constant float3x3 M_lms_to_oklab_sat = float3x3(
    float3(0.2104542553, 0.7936177850, -0.0040720468),
    float3(1.9779984951, -2.4285922050, 0.4505937099),
    float3(0.0259040371, 0.7827717662, -0.8086757660)
);

// M_oklab_to_lms_sat = inverse(M2_LMS_TO_LAB) (Bottosson 2020). Same
// high-precision values as before; bit-identical to Rust's cached
// `m2_inv` in oklab.rs.
constant float3x3 M_oklab_to_lms_sat = float3x3(
    float3(1.0000000000, 0.3963377774, 0.2158037573),
    float3(1.0000000000, -0.1055613458, -0.0638541728),
    float3(1.0000000000, -0.0894841775, -1.2914855480)
);

// M_lms_to_rec2020_sat = inverse(M_REC2020_TO_SRGB) @ inverse(M1_SRGB_TO_LMS)
// (numpy float64, rounded to 8 sig figs). Each `float3` is a ROW.
constant float3x3 M_lms_to_rec2020_sat = float3x3(
    float3( 2.13995843, -1.24643838,  0.10642154),
    float3(-0.88463381,  2.16319054, -0.27856253),
    float3(-0.04848752, -0.45453369,  1.50310914)
);

float3 rec2020_to_oklab_sat(float3 rgb) {
    float3 lms = rgb * M_rec2020_to_lms_sat;
    float3 lms_nl = sign(lms) * pow(abs(lms), float3(1.0 / 3.0));
    return lms_nl * M_lms_to_oklab_sat;
}

float3 oklab_to_rec2020_sat(float3 lab) {
    float3 lms_nl = lab * M_oklab_to_lms_sat;
    float3 lms = lms_nl * lms_nl * lms_nl;
    return lms * M_lms_to_rec2020_sat;
}

[[stitchable]] float4 sceneSaturation(
    coreimage::sampler_h src,
    float saturation
) {
    float4 color = float4(src.sample(src.coord()));
    if (abs(saturation) < 1e-3) return color;
    float scale = 1.0 + saturation / 100.0;
    float3 lab = rec2020_to_oklab_sat(color.rgb);
    float3 new_lab = float3(lab[0], lab[1] * scale, lab[2] * scale);
    return float4(oklab_to_rec2020_sat(new_lab), color.a);
}
