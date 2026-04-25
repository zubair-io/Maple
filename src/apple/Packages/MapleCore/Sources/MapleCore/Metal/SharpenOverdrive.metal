// SharpenOverdrive.metal — unsharp overdrive for sharpen_amount > 100.
// Mirrors raw-core/src/stages/sharpen.rs:65-76.
//
// Algorithm:
//   over_mix = (amount - 100) / 100
//   blurredEstimate = blur(estimate, radius_px)   // outside this kernel
//   out = estimate + (estimate - blurredEstimate) * over_mix
//
// Byte-identical at the per-pixel mix level to SceneUnsharp.metal
// (clarity / texture / overdrive all share the unsharp mix shape);
// kept as a separate kernel for orchestration clarity in
// applySceneSharpen. A follow-up DRY plan can merge once the
// orchestrator pattern is locked.

#include <CoreImage/CoreImage.h>

extern "C" float4 sharpenOverdrive(
    coreimage::sampler_h estimate,
    coreimage::sampler_h blurredEstimate,
    float overMix
) {
    float4 e = estimate.sample(estimate.coord());
    float4 b = blurredEstimate.sample(blurredEstimate.coord());
    if (abs(overMix) < 1e-3) return e;
    float3 mixed = e.rgb + (e.rgb - b.rgb) * overMix;
    return float4(mixed, e.a);
}
