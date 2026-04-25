// AgXViewTransform.metal — Log-encode + sigmoid LUT view transform (spec § 3.6a).
//
// The LUT is baked from src/scripts/derive_agx_lut.py and matches
// agx_lut.bin used by the Rust pipeline (AGX_VERSION 2).
//
// Constants (from agx_coeffs.rs):
//   AGX_MIN_EV   = -10.0
//   AGX_MAX_EV   =   6.5
//   AGX_MID_GRAY =   0.18
//   AGX_LUT_SIZE = 512
//
// The LUT is passed as a float texture (1D sampled as 1×512).
// Contrast modulates the sigmoid domain mapping (spec § 3.6a).

#include <CoreImage/CoreImage.h>

constant float AGX_MIN_EV   = -10.0;
constant float AGX_MAX_EV   =  6.5;
constant float AGX_MID_GRAY =  0.18;
constant float AGX_LUT_SIZE =  512.0;
constant float MID_NORM     = -AGX_MIN_EV / (AGX_MAX_EV - AGX_MIN_EV); // ~0.606

/// Log-encode a single scene-linear channel.
float agx_log_encode(float linear) {
    float eps = 1e-10;
    float log_val = log2(max(linear, eps)) - log2(AGX_MID_GRAY);
    return clamp((log_val - AGX_MIN_EV) / (AGX_MAX_EV - AGX_MIN_EV), 0.0, 1.0);
}

/// Sample the 1D LUT texture at normalized position t ∈ [0, 1].
float sample_lut(coreimage::sampler_h lut_sampler, float t) {
    return float(lut_sampler.sample(float2(t * (AGX_LUT_SIZE - 1.0) / AGX_LUT_SIZE, 0.0)).r);
}

/// Apply contrast modulation: expand/compress around MID_NORM
/// so that contrast=0 → identity, contrast=100 → steep sigmoid (spec § 3.6a).
float apply_contrast(float t, float contrast) {
    if (abs(contrast) < 1e-3) return t;
    float s = 1.0 + contrast / 200.0; // scale: 1.0 at 0, 1.5 at 100, 0.5 at -100
    float shifted = (t - MID_NORM) * s + MID_NORM;
    return clamp(shifted, 0.0, 1.0);
}

[[stitchable]] float4 agxViewTransform(
    coreimage::sampler_h src,
    coreimage::sampler_h lut,   // 1D LUT as 512×1 float texture
    float contrast              // -100..+100
) {
    float4 color = float4(src.sample(src.coord()));
    float3 p = color.rgb;

    // Log-encode each channel independently.
    float3 log_encoded = float3(
        agx_log_encode(p.r),
        agx_log_encode(p.g),
        agx_log_encode(p.b)
    );

    // Apply contrast modulation.
    log_encoded = float3(
        apply_contrast(log_encoded.r, contrast),
        apply_contrast(log_encoded.g, contrast),
        apply_contrast(log_encoded.b, contrast)
    );

    // LUT sample (sigmoid).
    float3 display = float3(
        sample_lut(lut, log_encoded.r),
        sample_lut(lut, log_encoded.g),
        sample_lut(lut, log_encoded.b)
    );

    return float4(display, color.a);
}
