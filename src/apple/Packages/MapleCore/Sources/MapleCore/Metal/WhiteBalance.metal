// WhiteBalance.metal — CIColorKernel that mirrors the Rust
// white_balance.rs stage (spec § 3.5).
//
// Input: scene-linear D65-Rec.2020 pixel — DCP has already neutralized
// to D65 by the time this kernel runs (raw-core's pipeline runs
// `dcp::apply` before Apple sees the buffer).
//
// The kernel takes TWO WB triples:
//   * (liveTemperature, liveTint)       — what the user wants now.
//   * (decodedTemperature, decodedTint) — what the cached decode was
//                                         rendered at (Rust applied
//                                         this WB scene-linear).
// Net gain = wb_gains(live) / wb_gains(decoded).
//
// When `liveTemperature == decodedTemperature` and `liveTint ==
// decodedTint`, the gain is identity and the kernel short-circuits.
// In Plan 2 v1 with `xmpPath: nil` the decoded WB is always 6500/0,
// so the kernel applies the user's WB directly. M3 generalises to
// "decoded == sidecar WB at decode time" so slider deltas remain
// exact when xmpPath is wired.

#include <CoreImage/CoreImage.h>

// Rec.2020 reference white (D65). Matches XYZ_D65 in raw-core
// (src/raw-pipeline/raw-core/src/color/matrices.rs:29).
constant float3 XYZ_D65 = float3(0.9504, 1.0000, 1.0888);

// XYZ (D65) to Rec.2020 — byte-identical to M_XYZ_D65_TO_REC2020 in
// raw-core (src/raw-pipeline/raw-core/src/color/matrices.rs:46-50).
// Each `float3` argument is a row of the Rust matrix (matches the
// convention used by SceneVibrance.metal's matrices).
constant float3x3 M_XYZ_D65_TO_REC2020 = float3x3(
    float3( 1.7166512, -0.3556708, -0.2533663),
    float3(-0.6666844,  1.6164812,  0.0157685),
    float3( 0.0176399, -0.0427706,  0.9421031)
);

// Hernández-Andrés (1999) polynomial. CCT (Kelvin) → CIE xy.
// Mirrors cct_to_xy in white_balance.rs:9-24.
float2 cct_to_xy(float cct) {
    float t = clamp(cct, 2000.0, 15000.0);
    float t2 = t * t;
    float t3 = t2 * t;
    float x;
    if (t <= 7000.0) {
        x =  0.244063
          + 99.11           / t
          + 2967800.0       / t2
          - 4607000000.0    / t3;
    } else {
        x =  0.237040
          + 247.48          / t
          + 1901800.0       / t2
          - 2006400000.0    / t3;
    }
    float y = -3.000 * x * x + 2.870 * x - 0.275;
    return float2(x, y);
}

// xy → XYZ with Y supplied. Matches xy_to_xyz in white_balance.rs:26-30.
float3 xy_to_xyz(float x, float y, float Y) {
    float X = (x / y) * Y;
    float Z = ((1.0 - x - y) / y) * Y;
    return float3(X, Y, Z);
}

// Per-channel Rec.2020 gain to move from D65 to (cct, tint).
// Normalized so green = 1. Mirrors wb_gains() in white_balance.rs:34-50.
float3 wb_gains(float cct, float tint) {
    float2 xy = cct_to_xy(cct);
    float y = xy.y + tint * 0.001;
    float3 xyz_target = xy_to_xyz(xy.x, y, 1.0);
    float3 target_rec2020 = M_XYZ_D65_TO_REC2020 * xyz_target;
    float3 d65_rec2020    = M_XYZ_D65_TO_REC2020 * XYZ_D65;
    float3 gain = float3(
        target_rec2020[0] / d65_rec2020[0],
        target_rec2020[1] / d65_rec2020[1],
        target_rec2020[2] / d65_rec2020[2]
    );
    float g = max(gain[1], 1e-6);
    return float3(gain[0] / g, 1.0, gain[2] / g);
}

[[stitchable]] float4 whiteBalance(
    coreimage::sampler_h src,
    float liveTemperature,
    float liveTint,
    float decodedTemperature,
    float decodedTint
) {
    float4 color = float4(src.sample(src.coord()));

    // Identity short-circuit when live == decoded.
    if (abs(liveTemperature - decodedTemperature) < 0.5 &&
        abs(liveTint - decodedTint) < 0.5) {
        return color;
    }

    float3 g_live    = wb_gains(liveTemperature, liveTint);
    float3 g_decoded = wb_gains(decodedTemperature, decodedTint);
    float3 ratio = float3(
        g_live[0] / max(g_decoded[0], 1e-6),
        g_live[1] / max(g_decoded[1], 1e-6),
        g_live[2] / max(g_decoded[2], 1e-6)
    );
    return float4(color.rgb * ratio, color.a);
}
