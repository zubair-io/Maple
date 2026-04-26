// SceneNRColor.metal — chroma noise reduction in Oklab. Mirrors
// `noise_reduction::apply_color` at src/raw-pipeline/raw-core/src/
// stages/noise_reduction.rs:61-96.
//
// Two CIColorKernel functions compose with the shared
// SeparableGaussianBlur compute kernel (shipped in Plan 2 v2 v1):
//
//   1. nrColorExtractAB(src) -> (a, b, 0, alpha)
//      Sample rec2020, convert to Oklab, pack a into R, b into G,
//      zero into B. The Swift wrapper feeds this output to
//      applySeparableGaussianBlur at integer radius derived from the
//      slider amount.
//
//   2. nrColorCombine(src, blurredAB, amount) -> rec2020
//      Sample original rec2020 + blurred-AB CIImage. Re-convert
//      rec2020 -> oklab to recover L without plumbing an oklab
//      CIImage intermediate. Overwrite (a, b) = (blurredAB.r,
//      blurredAB.g) (matches the writeback at noise_reduction.rs
//      :88-89 — full replacement, not a blend; the Rust shim's
//      `amount` controls radius only). Unconvert oklab -> rec2020.
//
// The `amount` argument on nrColorCombine is unused inside the
// kernel body — symmetric with SceneNRLuminance.metal.
//
// Oklab matrices duplicated with `_nrc` suffix per the established
// pattern at SceneSaturation.metal. As of Ticket 12 follow-up they are
// the Rust-equivalent Bottosson product matrices (see SceneSaturation.metal
// header for full derivation). Same DRY-oklab follow-up note applies
// as in SceneNRLuminance.metal.
//
// TODO codegen: lift these four matrices into `src/scripts/codegen/` once
// the scaffold lands. Today all three platforms hold these by hand.

#include <CoreImage/CoreImage.h>

// M_rec2020_to_lms_nrc = M1_SRGB_TO_LMS @ M_REC2020_TO_SRGB. Each
// `float3` is a ROW of the math matrix (Metal `v * M_metal` form).
constant float3x3 M_rec2020_to_lms_nrc = float3x3(
    float3( 0.61673040,  0.36021433,  0.02309135),
    float3( 0.26509597,  0.63584589,  0.09906860),
    float3( 0.10005846,  0.20389689,  0.69599049)
);

// M_lms_to_oklab_nrc = M2_LMS_TO_LAB (Bottosson 2020).
constant float3x3 M_lms_to_oklab_nrc = float3x3(
    float3(0.2104542553, 0.7936177850, -0.0040720468),
    float3(1.9779984951, -2.4285922050, 0.4505937099),
    float3(0.0259040371, 0.7827717662, -0.8086757660)
);

// M_oklab_to_lms_nrc = inverse(M2_LMS_TO_LAB).
constant float3x3 M_oklab_to_lms_nrc = float3x3(
    float3(1.0000000000, 0.3963377774, 0.2158037573),
    float3(1.0000000000, -0.1055613458, -0.0638541728),
    float3(1.0000000000, -0.0894841775, -1.2914855480)
);

// M_lms_to_rec2020_nrc = inverse(M_REC2020_TO_SRGB) @ inverse(M1_SRGB_TO_LMS).
constant float3x3 M_lms_to_rec2020_nrc = float3x3(
    float3( 2.13995843, -1.24643838,  0.10642154),
    float3(-0.88463381,  2.16319054, -0.27856253),
    float3(-0.04848752, -0.45453369,  1.50310914)
);

// Matrix layout: each `float3` to `float3x3(...)` is a COLUMN of the
// Metal matrix but a ROW of the math matrix — use `v * M_metal` to
// compute `M_math * v`. See SceneSaturation.metal header / Bug 2.
float3 rec2020_to_oklab_nrc(float3 rgb) {
    float3 lms = rgb * M_rec2020_to_lms_nrc;
    float3 lms_nl = sign(lms) * pow(abs(lms), float3(1.0 / 3.0));
    return lms_nl * M_lms_to_oklab_nrc;
}

float3 oklab_to_rec2020_nrc(float3 lab) {
    float3 lms_nl = lab * M_oklab_to_lms_nrc;
    float3 lms = lms_nl * lms_nl * lms_nl;
    return lms * M_lms_to_rec2020_nrc;
}

[[stitchable]] float4 nrColorExtractAB(
    coreimage::sampler_h src
) {
    float4 color = float4(src.sample(src.coord()));
    float3 lab = rec2020_to_oklab_nrc(color.rgb);
    return float4(lab.y, lab.z, 0.0, color.a);
}

[[stitchable]] float4 nrColorCombine(
    coreimage::sampler_h src,
    coreimage::sampler_h blurredAB,
    float amount  // unused; see header comment
) {
    float4 color = float4(src.sample(src.coord()));
    float4 bAB = float4(blurredAB.sample(blurredAB.coord()));
    float3 lab = rec2020_to_oklab_nrc(color.rgb);
    lab.y = bAB.r;
    lab.z = bAB.g;
    float3 rgb_out = oklab_to_rec2020_nrc(lab);
    return float4(rgb_out, color.a);
}
