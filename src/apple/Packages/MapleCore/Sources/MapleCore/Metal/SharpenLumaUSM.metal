// SharpenLumaUSM.metal — luminance-only unsharp-mask sharpening,
// per-pixel. Mirrors `raw-core/src/stages/sharpen.rs` byte-for-byte
// (BT.2020 luma weights, smoothstep shadow guard, scale clamp).
//
// Replaces the per-channel Richardson-Lucy iteration kernels
// (RichardsonLucyMixer.metal) and the per-channel overdrive kernel
// (SharpenOverdrive.metal). The 3-iteration RL implementation
// produced saturated chroma artifacts in shadow regions where one
// channel (typically blue, after Bayer + WB gain) had a noise spike
// that ratio'd to many-fold larger than other channels — the user-
// reported "blue specks in shadows" pattern. Luma-only USM scales
// every RGB channel at a pixel by the SAME factor, so chroma ratios
// are preserved by construction.
//
// Pipeline orchestration in MapleKernels.applySceneSharpen:
//
//   blurred   = applySeparableGaussianBlur(observed, radius_px)
//   sharpened = sharpenLumaUSM(observed, blurred)
//   final     = sharpenEdgeMix(observed, sharpened, lumaPlane,
//                              amount/100, detail/100, masking/100)
//
// The slider `amount` is applied entirely by `sharpenEdgeMix`. This
// kernel produces a "full-strength sharpened" buffer (equivalent to
// amount=100, masking=0) that the edge mix scales / attenuates.
//
// Constants must stay in lockstep with sharpen.rs:
//   LUMA_R/G/B      — BT.2020 luma weights (0.2627, 0.6780, 0.0593).
//   SHADOW_EPSILON  — 1e-4 (~13 EV below mid-gray; below this the
//                     scale is held at 1.0 so shadow noise can't
//                     amplify).
//   SHADOW_BAND     — 4.0 (smoothstep transition width above the
//                     epsilon).
//   MAX_SCALE       — 4.0 (per-pixel amplification cap; bounds
//                     runaway scale at degenerate pixels).
//   MIN_SCALE       — 0.0 (floor; prevents channel inversion at
//                     extreme edges into deep shadow).
//
// Style: matches the [[stitchable]] CIColorKernel sources in this
// directory.

#include <CoreImage/CoreImage.h>

[[stitchable]] float4 sharpenLumaUSM(
    coreimage::sampler_h observed,
    coreimage::sampler_h blurred
) {
    const float LUMA_R = 0.2627;
    const float LUMA_G = 0.6780;
    const float LUMA_B = 0.0593;
    const float SHADOW_EPSILON = 1e-4;
    const float SHADOW_BAND    = 4.0;
    const float MAX_SCALE      = 4.0;
    const float MIN_SCALE      = 0.0;

    float4 o = float4(observed.sample(observed.coord()));
    float4 b = float4(blurred.sample(blurred.coord()));

    float luma_in   = LUMA_R * o.r + LUMA_G * o.g + LUMA_B * o.b;
    float luma_blur = LUMA_R * b.r + LUMA_G * b.g + LUMA_B * b.b;
    float luma_out  = luma_in + (luma_in - luma_blur);

    // Shadow guard: smoothstep weight = 0 below SHADOW_EPSILON,
    // = 1 above SHADOW_BAND × SHADOW_EPSILON. `smoothstep` here is
    // Metal's built-in (matches the GLSL signature exactly).
    float weight    = smoothstep(SHADOW_EPSILON,
                                  SHADOW_BAND * SHADOW_EPSILON,
                                  luma_in);
    float safe_luma = max(luma_in, SHADOW_EPSILON);
    float raw_scale = luma_out / safe_luma;
    float bounded   = clamp(raw_scale, MIN_SCALE, MAX_SCALE);
    float scale     = 1.0 + weight * (bounded - 1.0);

    return float4(o.rgb * scale, o.a);
}
