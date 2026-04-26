// AgXViewTransform.metal — Log-encode + inline-sigmoid view transform (spec § 3.6a).
//
// This is **Maple AgX** — photography-tuned, NOT Blender-faithful. The
// polynomial is fitted to ACR baseline renders so mid-gray is preserved
// (scene 0.18 → display ≈ 0.25) instead of lifted to ~0.50 the way
// Blender's AgX_Default_Contrast places it. See `derive_agx_lut.py` for
// the anchor set and fit method. Inlining the polynomial drops the
// LUT-image dependency entirely — see ticket #08 for the LUT-sampler
// binding issue we hit on modern macOS CoreImage.
//
// Coefficients (frozen; mirror derive_agx_lut.py — bump AGX_VERSION on edit):
//   y = +45.168672  * x^6
//       -153.659289 * x^5
//       +188.476772 * x^4
//       -101.333581 * x^3
//       + 24.458269 * x^2
//       -  2.131000 * x
//       +  0.000235
// where x is the normalized-log position of the scene-linear value.
//
// Constants (mirror agx_coeffs.rs):
//   AGX_MIN_EV   = -10.0
//   AGX_MAX_EV   =   6.5
//   AGX_MID_GRAY =   0.18
//
// Contrast modulates the sigmoid domain mapping (spec § 3.6a).

#include <CoreImage/CoreImage.h>

constant float AGX_MIN_EV   = -10.0;
constant float AGX_MAX_EV   =  6.5;
constant float AGX_MID_GRAY =  0.18;
constant float MID_NORM     = -AGX_MIN_EV / (AGX_MAX_EV - AGX_MIN_EV); // ~0.606

/// Log-encode a single scene-linear channel.
float agx_log_encode(float linear) {
    float eps = 1e-10;
    float log_val = log2(max(linear, eps)) - log2(AGX_MID_GRAY);
    return clamp((log_val - AGX_MIN_EV) / (AGX_MAX_EV - AGX_MIN_EV), 0.0, 1.0);
}

/// Inline Maple AgX sigmoid — photography-tuned 6th-order polynomial.
/// `x` is the normalized-log position in [0, 1]; output is display-linear in [0, 1].
/// Coefficients mirror `derive_agx_lut.py` MAPLE_AGX_A0..A6.
float agx_sigmoid(float x) {
    x = clamp(x, 0.0, 1.0);
    float x2 = x * x;
    float x4 = x2 * x2;
    float y =   45.168672  * x4 * x2
            - 153.659289   * x4 * x
            + 188.476772   * x4
            - 101.333581   * x2 * x
            +  24.458269   * x2
            -   2.131000   * x
            +   0.000235;
    return clamp(y, 0.0, 1.0);
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
    coreimage::sample_t src,
    float contrast              // -100..+100
) {
    float4 color = float4(src);
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

    // Inline sigmoid (no LUT image).
    float3 display = float3(
        agx_sigmoid(log_encoded.r),
        agx_sigmoid(log_encoded.g),
        agx_sigmoid(log_encoded.b)
    );

    return float4(display, color.a);
}
