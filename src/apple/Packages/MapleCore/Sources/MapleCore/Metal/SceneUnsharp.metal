// SceneUnsharp.metal — shared per-pixel unsharp-mask mix used by
// SceneClarity (radius 40) and SceneTexture (radius 3). Mirrors the
// per-pixel mix in raw-core/src/stages/clarity.rs:16-20 and
// raw-core/src/stages/texture.rs:16-20 (the two are byte-identical
// at the algorithm level — only the radius constant differs, and
// that difference is upstream of this kernel in the blur scratch).
//
// Algorithm:
//   amount = slider / 100
//   for each channel: out = src + (src - blurred) * amount
//
// At amount = 0 → identity. At amount = +1 → 2x high-frequency boost.
// At amount = -1 → halfway-blurred (negative slider blends toward the
// blurred image).
//
// Style note: matches the existing CIColorKernel sources in this
// directory (SceneToneControls, SceneVibrance, SceneSaturation,
// WhiteBalance) — `extern "C"` with `coreimage::sampler_h` arguments
// and a direct `float4` sample assignment. The runtime loader path
// is `MetalKernels.loadKernel(file:function:)` ->
// `CIKernel.kernels(withMetalString:)`. The same loader-path quirk
// flagged in Spike 1.1 (modern macOS may require `[[stitchable]]` and
// half4 conversion at runtime) applies to all kernels in this directory
// uniformly; harmonising that is out of scope per the spike notes.

#include <CoreImage/CoreImage.h>

extern "C" float4 sceneUnsharp(
    coreimage::sampler_h src,
    coreimage::sampler_h blurred,
    float amount
) {
    float4 s = src.sample(src.coord());
    float4 b = blurred.sample(blurred.coord());
    if (abs(amount) < 1e-3) return s;
    float3 mixed = s.rgb + (s.rgb - b.rgb) * amount;
    return float4(mixed, s.a);
}
