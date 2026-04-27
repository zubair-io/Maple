// SceneToneControls.metal — CIColorKernel that mirrors the Rust
// scene_tone_controls.rs stage (spec § 3.6).
//
// Input: scene-linear Rec.2020 pixel from the RAW decode.
// Parameters:
//   exposure    – EV shift (-4..+4)
//   highlights  – compression above knee (-100..+100)
//   shadows     – lift in deep values (-100..+100)
//   whites      – near-white scalar gain (-100..+100)
//   blacks      – additive black-point shift (-100..+100)
//
// Note: contrast modulates the AgXViewTransform sigmoid slope (§ 3.6a)
//       and is NOT applied here.

#include <CoreImage/CoreImage.h>

// Rec.2020 luminance coefficients (matches Rust LUMA_REC2020 array).
constant float3 LUMA_REC2020 = float3(0.2627, 0.6780, 0.0593);

float smoothstep_f(float e0, float e1, float x) {
    float t = clamp((x - e0) / (e1 - e0), 0.0, 1.0);
    return t * t * (3.0 - 2.0 * t);
}

[[stitchable]] float4 sceneToneControls(
    coreimage::sampler_h src,
    float exposure,
    float highlights,
    float shadows,
    float whites,
    float blacks
) {
    float4 color = float4(src.sample(src.coord()));
    float3 p = color.rgb;

    // 1. Exposure: p *= 2^ev
    if (abs(exposure) >= 1e-6) {
        float gain = exp2(exposure);
        p *= gain;
    }

    // 2. Highlights — soft compression above knee=1.0
    if (abs(highlights) >= 1e-3) {
        float h_amount = highlights / 100.0;
        float h_denom = 1.0 + h_amount * 2.0;
        if (abs(h_denom) > 1e-6) {
            if (p.r > 1.0) p.r = 1.0 + (p.r - 1.0) / h_denom;
            if (p.g > 1.0) p.g = 1.0 + (p.g - 1.0) / h_denom;
            if (p.b > 1.0) p.b = 1.0 + (p.b - 1.0) / h_denom;
        }
    }

    // 3. Shadows — luminance-masked lift of deep values
    if (abs(shadows) >= 1e-3) {
        float luma = dot(p, LUMA_REC2020);
        float mask = 1.0 - smoothstep_f(0.0, 0.1, luma);
        float s_factor = (shadows / 100.0) * 0.5;
        float lift = mask * s_factor;
        p += p * lift;
    }

    // 4. Whites — small scalar gain near diffuse white endpoint
    if (abs(whites) >= 1e-3) {
        float w_gain = 1.0 + whites / 200.0;
        p *= w_gain;
    }

    // 5. Blacks — additive shift, then floor at 0 to keep deep shadows
    //    physical (no negative scene-linear values).
    //
    // Pre-fix: `p += blacks/400` could drive deep-shadow pixels negative
    // (e.g. blacks=-50 subtracts 0.125 across all channels). When the
    // downstream AgX shader log-encodes per channel, negative values
    // clamp to log2(1e-10), producing display ≈ 0 — but if even one
    // channel survives just-positive (typically R in skin tones), the
    // AgX output is R-only, surfacing as pink/magenta speckle on what
    // should be uniform black. With Sharpen at radius 1 amplifying
    // per-channel mismatch, this is the magenta-on-skin artifact in
    // the user screenshot for Ticket 11 / 11-Bugs.md (Bug A). On the
    // Apple fp16 path the same negative-input funnel additionally
    // shows up as the white-plateau symptom — sampler_h precision
    // makes the negative-channel funnel into AgX brittle.
    //
    // Post-fix: floor each channel at 0 immediately after the
    // additive shift. Mirrors the Rust raw-core implementation in
    // src/raw-pipeline/raw-core/src/stages/scene_tone_controls.rs:80
    // byte-for-byte at the algorithm level. See the investigation spec
    // under docs/superpowers/specs/2026-04-26-blacks-clarity-bug-investigation.md.
    if (abs(blacks) >= 1e-3) {
        float b_add = blacks / 400.0;
        p = max(p + b_add, float3(0.0));
    }

    return float4(p, color.a);
}
