// SceneClarity.metal — luminance-preserving unsharp mask in Rec.2020.
// Mirrors `clarity::apply` in src/raw-pipeline/raw-core/src/stages/clarity.rs
// (luma-space variant). Operates on the scene-linear Rec.2020 stream.
//
// Two CIColorKernel functions compose with the shared
// SeparableGaussianBlur compute kernel (shipped in Plan 2 v2 v1, see
// Metal/SeparableGaussianBlur.metal):
//
//   1. clarityExtractLuma(src) -> (luma, luma, luma, alpha)
//      Sample rec2020, dot with LUMA_REC2020 to get luma, splat into
//      all 3 channels so the existing 3-pass box-blur compute kernel
//      can blur it as if it were RGB. The Swift wrapper feeds this
//      output to applySeparableGaussianBlur(radius=40).
//
//   2. clarityCombine(src, blurredLuma, amount) -> rec2020
//      Recompute the original luma from the source pixel (cheap), build
//      luma_boost = luma + (luma - blurredLuma.r) * amount, then scale
//      RGB by (luma_boost / max(luma, LUMA_FLOOR)). Multiplying RGB by a
//      scalar preserves the R:G:B ratios exactly — no chroma fringing.
//
// Why luma-space (vs the previous SceneUnsharp per-channel mix): the
// per-channel boost amplifies hue differences asymmetrically on edges
// where R/G/B differ, producing magenta/cyan halos around fine detail
// (Bug B in 11-Bugs). ACR's clarity is luma-only for the same reason.
// The Rust core was changed in lockstep; tests in clarity.rs assert
// chromaticity preservation on a coloured edge and finite-output on
// negative-luma input.
//
// LUMA_REC2020 matches the constants in SceneToneControls.metal,
// derive_agx_lut.py, and raw-core/src/stages/scene_tone_controls.rs.
//
// Style: same loader path as the other CIColorKernels in this directory
// (`extern "C"` via the [[stitchable]] attribute,
// `coreimage::sampler_h` arguments, direct float4 sample reads).

#include <CoreImage/CoreImage.h>

constant float3 LUMA_REC2020_C = float3(0.2627, 0.6780, 0.0593);
constant float LUMA_FLOOR_C = 1e-6;

[[stitchable]] float4 clarityExtractLuma(
    coreimage::sampler_h src
) {
    float4 color = float4(src.sample(src.coord()));
    float luma = dot(color.rgb, LUMA_REC2020_C);
    return float4(luma, luma, luma, color.a);
}

[[stitchable]] float4 clarityCombine(
    coreimage::sampler_h src,
    coreimage::sampler_h blurredLuma,
    float amount
) {
    float4 color = float4(src.sample(src.coord()));
    float4 bl = float4(blurredLuma.sample(blurredLuma.coord()));
    float luma = dot(color.rgb, LUMA_REC2020_C);
    float boost = luma + (luma - bl.r) * amount;
    float denom = max(luma, LUMA_FLOOR_C);
    float scale = boost / denom;
    return float4(color.rgb * scale, color.a);
}
