// SceneNRLuminance.metal — luminance noise reduction in Oklab. Mirrors
// `noise_reduction::apply_luminance` at src/raw-pipeline/raw-core/src/
// stages/noise_reduction.rs:20-55.
//
// Two CIColorKernel functions compose with the shared
// SeparableGaussianBlur compute kernel (shipped in Plan 2 v2 v1, see
// Metal/SeparableGaussianBlur.metal):
//
//   1. nrLuminanceExtractL(src) -> (L, L, L, alpha)
//      Sample rec2020, convert to Oklab, splat L into all 3 channels.
//      The Swift wrapper feeds this output to applySeparableGaussianBlur
//      at integer radius derived from the slider amount.
//
//   2. nrLuminanceCombine(src, blurredL, amount) -> rec2020
//      Sample original rec2020 + blurred-L CIImage. Re-convert rec2020
//      -> oklab to recover (a, b) without plumbing an oklab CIImage
//      intermediate. Overwrite L = blurredL.r (matches the writeback
//      at noise_reduction.rs:48-49 — full replacement, not a blend;
//      the Rust shim's `amount` controls radius only). Unconvert
//      oklab -> rec2020.
//
// The `amount` argument on nrLuminanceCombine is unused inside the
// kernel body — it exists to (a) mark in code that the slider value
// is the source of the radius scaling at the Swift layer, and (b)
// keep ABI symmetry with M2's sceneUnsharp(src, blurred, amount)
// from Metal/SceneUnsharp.metal, so a future "full NLM" upgrade can
// swap kernel bodies without changing the Swift wrapper signature.
//
// Oklab matrices are duplicated here with `_nrl` suffix per the
// established pattern at SceneSaturation.metal:11-16. A follow-up
// "DRY oklab matrices" plan can factor SceneVibrance / SceneSaturation
// / SceneNRLuminance / SceneNRColor into a shared oklab.metal once
// the include-from-Bundle mechanics are exercised under load (Spike
// 1.2 PASSED in v2 v1, so the green light exists).

#include <CoreImage/CoreImage.h>

constant float3x3 M_rec2020_to_lms_nrl = float3x3(
    float3(0.6370481, 0.2657101, 0.0365291),
    float3(0.3320989, 0.6936245, 0.0374060),
    float3(0.0002832, 0.0182337, 0.9994374)
);

constant float3x3 M_lms_to_oklab_nrl = float3x3(
    float3(0.2104542553, 0.7936177850, -0.0040720468),
    float3(1.9779984951, -2.4285922050, 0.4505937099),
    float3(0.0259040371, 0.7827717662, -0.8086757660)
);

constant float3x3 M_oklab_to_lms_nrl = float3x3(
    float3(1.0000000000, 0.3963377774, 0.2158037573),
    float3(1.0000000000, -0.1055613458, -0.0638541728),
    float3(1.0000000000, -0.0894841775, -1.2914855480)
);

constant float3x3 M_lms_to_rec2020_nrl = float3x3(
    float3(1.6970305, -0.7288047, 0.0413840),
    float3(-0.5065012, 1.6510782, -0.0577547),
    float3(-0.0247447, 0.0438581, 1.0759636)
);

// Matrix layout: each `float3` to `float3x3(...)` is a COLUMN of the
// Metal matrix but a ROW of the math matrix — use `v * M_metal` to
// compute `M_math * v`. See SceneSaturation.metal header / Bug 2.
float3 rec2020_to_oklab_nrl(float3 rgb) {
    float3 lms = rgb * M_rec2020_to_lms_nrl;
    float3 lms_nl = sign(lms) * pow(abs(lms), float3(1.0 / 3.0));
    return lms_nl * M_lms_to_oklab_nrl;
}

float3 oklab_to_rec2020_nrl(float3 lab) {
    float3 lms_nl = lab * M_oklab_to_lms_nrl;
    float3 lms = lms_nl * lms_nl * lms_nl;
    return lms * M_lms_to_rec2020_nrl;
}

[[stitchable]] float4 nrLuminanceExtractL(
    coreimage::sampler_h src
) {
    float4 color = float4(src.sample(src.coord()));
    float3 lab = rec2020_to_oklab_nrl(color.rgb);
    return float4(lab.x, lab.x, lab.x, color.a);
}

[[stitchable]] float4 nrLuminanceCombine(
    coreimage::sampler_h src,
    coreimage::sampler_h blurredL,
    float amount  // unused; see header comment
) {
    float4 color = float4(src.sample(src.coord()));
    float4 bl = float4(blurredL.sample(blurredL.coord()));
    float3 lab = rec2020_to_oklab_nrl(color.rgb);
    lab.x = bl.r;
    float3 rgb_out = oklab_to_rec2020_nrl(lab);
    return float4(rgb_out, color.a);
}
