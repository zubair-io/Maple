// RichardsonLucyMixer.metal — per-iteration arithmetic for 3-iter
// Richardson-Lucy capture sharpening. Mirrors the per-pixel body of
// raw-core/src/stages/sharpen.rs:42-60 (the loop over RL_ITERS = 3).
//
// Two CIColorKernel functions compose with the shared
// SeparableGaussianBlur compute kernel (shipped in Plan 2 v2 v1) to
// implement the full RL iteration:
//
//   For each iteration n in 0..3:
//     reblur     = applySeparableGaussianBlur(estimate, radius_px)
//     ratio      = rlRatio(observed, reblur)
//     correction = applySeparableGaussianBlur(ratio, radius_px)
//     estimate   = rlMultiply(estimate, correction)
//
// EPSILON = 1e-5 matches sharpen.rs:17 byte-for-byte. Per-channel
// independence matches sharpen.rs:49-53 (ratio computed per RGB
// component) and sharpen.rs:58-60 (estimate multiplied per RGB
// component).
//
// Style note: matches the existing CIColorKernel sources in this
// directory (SceneToneControls, SceneVibrance, SceneSaturation,
// SceneUnsharp, SceneNRLuminance, SceneNRColor) — `extern "C"` with
// `coreimage::sampler_h` arguments and a direct `float4` sample
// assignment. No `[[stitchable]]` attribute (Step 1.5 of Task 1
// confirmed v2 v1 / v2 v2 production kernels do not use it).

#include <CoreImage/CoreImage.h>

// Per-pixel ratio: observed / max(reblur, EPSILON) per channel.
// Matches sharpen.rs:46-53.
[[stitchable]] float4 rlRatio(
    coreimage::sampler_h observed,
    coreimage::sampler_h reblur
) {
    const float EPSILON = 1e-5;
    float4 o = float4(observed.sample(observed.coord()));
    float4 rb = float4(reblur.sample(reblur.coord()));
    float3 ratio = o.rgb / max(rb.rgb, float3(EPSILON));
    return float4(ratio, o.a);
}

// Per-pixel multiply: estimate * correction per channel.
// Matches sharpen.rs:56-60.
[[stitchable]] float4 rlMultiply(
    coreimage::sampler_h estimate,
    coreimage::sampler_h correction
) {
    float4 e = float4(estimate.sample(estimate.coord()));
    float4 c = float4(correction.sample(correction.coord()));
    return float4(e.rgb * c.rgb, e.a);
}
