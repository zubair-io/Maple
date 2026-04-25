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
// pattern at SceneSaturation.metal:11-16. Same DRY-oklab follow-up
// note applies as in SceneNRLuminance.metal.

#include <CoreImage/CoreImage.h>

constant float3x3 M_rec2020_to_lms_nrc = float3x3(
    float3(0.6370481, 0.2657101, 0.0365291),
    float3(0.3320989, 0.6936245, 0.0374060),
    float3(0.0002832, 0.0182337, 0.9994374)
);

constant float3x3 M_lms_to_oklab_nrc = float3x3(
    float3(0.2104542553, 0.7936177850, -0.0040720468),
    float3(1.9779984951, -2.4285922050, 0.4505937099),
    float3(0.0259040371, 0.7827717662, -0.8086757660)
);

constant float3x3 M_oklab_to_lms_nrc = float3x3(
    float3(1.0000000000, 0.3963377774, 0.2158037573),
    float3(1.0000000000, -0.1055613458, -0.0638541728),
    float3(1.0000000000, -0.0894841775, -1.2914855480)
);

constant float3x3 M_lms_to_rec2020_nrc = float3x3(
    float3(1.6970305, -0.7288047, 0.0413840),
    float3(-0.5065012, 1.6510782, -0.0577547),
    float3(-0.0247447, 0.0438581, 1.0759636)
);

float3 rec2020_to_oklab_nrc(float3 rgb) {
    float3 lms = M_rec2020_to_lms_nrc * rgb;
    float3 lms_nl = sign(lms) * pow(abs(lms), float3(1.0 / 3.0));
    return M_lms_to_oklab_nrc * lms_nl;
}

float3 oklab_to_rec2020_nrc(float3 lab) {
    float3 lms_nl = M_oklab_to_lms_nrc * lab;
    float3 lms = lms_nl * lms_nl * lms_nl;
    return M_lms_to_rec2020_nrc * lms;
}

extern "C" float4 nrColorExtractAB(
    coreimage::sampler_h src
) {
    float4 color = float4(src.sample(src.coord()));
    float3 lab = rec2020_to_oklab_nrc(color.rgb);
    return float4(lab.y, lab.z, 0.0, color.a);
}

extern "C" float4 nrColorCombine(
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
