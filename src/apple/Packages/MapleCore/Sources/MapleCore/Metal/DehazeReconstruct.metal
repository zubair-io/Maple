// DehazeReconstruct.metal — final per-pixel scene-radiance recovery for
// the dehaze chain. Mirrors the per-pixel reconstruction loop at
// raw-core/src/stages/dehaze.rs:163-178.
//
// CIColorKernel signature: takes the original src CIImage, the meanA
// and meanB CIImage scratches (single-channel each, but Apple wraps
// them as RGBA where R holds the value), the guide CIImage (single-
// channel), the atmospheric light vector (3 floats), and the dehaze
// scale (clamp((dehaze/100), -1, +1)).
//
// Per-pixel steps (mirroring dehaze.rs:163-178):
//   1. t_refined = clamp(meanA * guide + meanB, 0, 1)  -- final guided-
//      filter apply, folded into reconstruction to save a render pass.
//   2. if scale >= 0:
//        t_eff = max(t_refined + (1 - t_refined) * (1 - scale), t_floor=0.1)
//      else:
//        t_eff = max(min(t_refined + (1 - t_refined) * (-scale), 1.0), t_floor)
//   3. J_c = (I_c - A_c) / t_eff + A_c
//
// Returns J as the rec2020 output pixel.

#include <CoreImage/CoreImage.h>

[[stitchable]] float4 dehazeReconstruct(
    coreimage::sampler_h src,
    coreimage::sampler_h meanA,
    coreimage::sampler_h meanB,
    coreimage::sampler_h guide,
    float A_r,
    float A_g,
    float A_b,
    float scale  // clamp((dehaze/100), -1, +1)
) {
    float4 color = float4(src.sample(src.coord()));
    float ma = float(meanA.sample(meanA.coord()).r);
    float mb = float(meanB.sample(meanB.coord()).r);
    float gv = float(guide.sample(guide.coord()).r);

    float t_refined = ma * gv + mb;
    t_refined = clamp(t_refined, 0.0, 1.0);

    const float t_floor = 0.1;
    float t_eff;
    if (scale >= 0.0) {
        t_eff = max(t_refined + (1.0 - t_refined) * (1.0 - scale), t_floor);
    } else {
        t_eff = max(min(t_refined + (1.0 - t_refined) * (-scale), 1.0), t_floor);
    }

    float3 A = float3(A_r, A_g, A_b);
    float3 I = color.rgb;
    float3 J = (I - A) / t_eff + A;
    return float4(J, color.a);
}
