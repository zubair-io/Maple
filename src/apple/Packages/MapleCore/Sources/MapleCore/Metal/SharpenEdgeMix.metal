// SharpenEdgeMix.metal — luminance extraction + edge-aware final mix
// for 3-iter Richardson-Lucy sharpening. Mirrors raw-core/src/stages/
// sharpen.rs:79-123.
//
// Two CIKernel functions:
//
//   1. sharpenLuminance(src) -> (L, L, L, alpha)
//      Sample rec2020, compute Rec.2020 BT.2020 luma
//      L = 0.2627*r + 0.6780*g + 0.0593*b, splat into RGB.
//      Per-pixel only — `CIColorKernel`. Matches sharpen.rs:87-89.
//
//   2. sharpenEdgeMix(observed, sharpened, luma, overallMix,
//                     detailAtten, maskingThreshold) -> rec2020
//      Sample observed + sharpened CIImages at the centre pixel.
//      Compute the edge gradient via central-difference samples on
//      the luma plane (4 neighbour samples: lumaPlane(x±1, y),
//      lumaPlane(x, y±1)). Decide edge-vs-flat membership:
//          if maskingThreshold > 1e-3:
//              g_norm = clamp(g / 0.2, 0, 1)
//              edge = (g_norm >= maskingThreshold) ? 1.0 : detailAtten
//          else:
//              edge = 1.0  // no edge gating; mix everywhere equally
//      Final mix:
//          mix = overallMix * edge
//          out = observed + (sharpened - observed) * mix
//      Matches sharpen.rs:103-123 byte-for-byte.
//
// Spatial sampling: confirmed PASS by Task 3 Step 3.1 micro-spike.
// `coreimage::sampler_h.sample(coord + offset)` works in `CIKernel`
// (not `CIColorKernel`); the kernel loader returns `CIKernel`, so
// the cache field `_sharpenEdgeMix` is typed `CIKernel?`. The existing
// AgXViewTransform.metal sample_lut() helper is a load-bearing
// existence proof for non-coord() sampling inside a CIKernel.
//
// Style note: unlike `SceneNRLuminance.metal` etc. (per-pixel
// CIColorKernels), this file has one CIColorKernel (sharpenLuminance)
// AND one CIKernel (sharpenEdgeMix). The loader path
// `CIKernel.kernels(withMetalString:)` returns `[CIKernel]`; we cast
// to `CIColorKernel` for the first, leave as `CIKernel` for the
// second, in the loaders at MetalKernels.swift.

#include <CoreImage/CoreImage.h>

// Per-pixel: extract Rec.2020 BT.2020 luma; splat into RGB.
// Matches sharpen.rs:87-89: 0.2627 * r + 0.6780 * g + 0.0593 * b.
extern "C" float4 sharpenLuminance(
    coreimage::sampler_h src
) {
    float4 c = float4(src.sample(src.coord()));
    float L = 0.2627 * c.r + 0.6780 * c.g + 0.0593 * c.b;
    return float4(L, L, L, c.a);
}

// Edge-aware mix. Computes gradient magnitude via central-difference
// 4-tap reads on the luma plane, applies the masking threshold, and
// mixes observed -> sharpened by the per-pixel mix factor.
extern "C" float4 sharpenEdgeMix(
    coreimage::sampler_h observed,
    coreimage::sampler_h sharpened,
    coreimage::sampler_h luma,
    float overallMix,
    float detailAtten,
    float maskingThreshold
) {
    float4 o = float4(observed.sample(observed.coord()));
    float4 s = float4(sharpened.sample(sharpened.coord()));

    float edge = 1.0;
    if (maskingThreshold > 1e-3) {
        // Central-difference gradient. luma.size() is the source
        // extent in pixels; offsetting by float2(1, 0) / luma.size()
        // in sampler-space coords gives a 1-px shift.
        float2 invSize = 1.0 / luma.size();
        float lXr = luma.sample(luma.coord() + float2( 1.0, 0.0) * invSize).r;
        float lXl = luma.sample(luma.coord() + float2(-1.0, 0.0) * invSize).r;
        float lYd = luma.sample(luma.coord() + float2( 0.0, 1.0) * invSize).r;
        float lYu = luma.sample(luma.coord() + float2( 0.0,-1.0) * invSize).r;
        float gx = lXr - lXl;
        float gy = lYd - lYu;
        float g = sqrt(gx * gx + gy * gy);
        // Normalize: typical edge gradient magnitude ~0.2 per
        // sharpen.rs:109. clamp to [0, 1].
        float gNorm = clamp(g / 0.2, 0.0, 1.0);
        edge = (gNorm >= maskingThreshold) ? 1.0 : detailAtten;
    }

    float mixK = overallMix * edge;
    float3 out = o.rgb + (s.rgb - o.rgb) * mixK;
    return float4(out, o.a);
}
