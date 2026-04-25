#version 300 es
// WhiteBalance.frag — port of WhiteBalance.metal:84-107 (Plan 3 M2.1).
//
// Input: scene-linear D65-Rec.2020 fp16 RGBA texture (DCP-neutralized).
// Two WB triples in / RGB out; alpha pass-through.
//
// Mirrors src/apple/Packages/MapleCore/Sources/MapleCore/Metal/WhiteBalance.metal
// byte-for-byte on the math; structural diffs are commented inline.

precision highp float;

in  vec2 vTexCoord;
out vec4 outColor;

uniform sampler2D uSrc;
uniform float uLiveTemperature;     // Kelvin
uniform float uLiveTint;            // -100..100
uniform float uDecodedTemperature;  // Kelvin
uniform float uDecodedTint;         // -100..100

// Rec.2020 reference white (D65). Matches XYZ_D65 in WhiteBalance.metal:26.
const vec3 XYZ_D65 = vec3(0.9504, 1.0000, 1.0888);

// XYZ (D65) to Rec.2020 — byte-identical to WhiteBalance.metal:32-36.
//
// Both Metal `float3x3` and GLSL `mat3` constructors take COLUMNS as
// `float3`/`vec3` arguments. Apple's source-of-truth comment at
// WhiteBalance.metal:30-31 says "Each `float3` argument is a row of the
// Rust matrix" — that's how the Apple author thinks of the matrix in
// the source, but Metal stores those vectors as columns. To match
// Apple's runtime behaviour (so M*v in WebGL == M*v in Metal), the
// GLSL `mat3` must take the SAME `vec3` arguments as Apple, layered as
// columns. The end-result matrix differs from the standard XYZ→Rec.2020
// definition by a transpose, but for the white-balance ratio code below
// (`g_live / g_decoded`) any consistent transformation cancels, and
// matching Apple bit-for-bit is what M2.1's snapshot test asserts.
const mat3 M_XYZ_D65_TO_REC2020 = mat3(
    vec3( 1.7166512, -0.3556708, -0.2533663),  // mirrors Apple's first float3 arg
    vec3(-0.6666844,  1.6164812,  0.0157685),  // mirrors Apple's second float3 arg
    vec3( 0.0176399, -0.0427706,  0.9421031)   // mirrors Apple's third float3 arg
);

// Hernández-Andrés (1999) polynomial. CCT (Kelvin) → CIE xy.
// Mirrors WhiteBalance.metal:40-58 / white_balance.rs:9-24.
vec2 cct_to_xy(float cct) {
    float t  = clamp(cct, 2000.0, 15000.0);
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
    return vec2(x, y);
}

// xy → XYZ with Y supplied. Mirrors WhiteBalance.metal:61-65.
vec3 xy_to_xyz(float x, float y, float Y) {
    float X = (x / y) * Y;
    float Z = ((1.0 - x - y) / y) * Y;
    return vec3(X, Y, Z);
}

// Per-channel Rec.2020 gain to move from D65 to (cct, tint).
// Normalized so green = 1. Mirrors WhiteBalance.metal:69-82.
vec3 wb_gains(float cct, float tint) {
    vec2 xy = cct_to_xy(cct);
    float y = xy.y + tint * 0.001;
    vec3 xyz_target  = xy_to_xyz(xy.x, y, 1.0);
    vec3 target_rec2020 = M_XYZ_D65_TO_REC2020 * xyz_target;
    vec3 d65_rec2020    = M_XYZ_D65_TO_REC2020 * XYZ_D65;
    vec3 gain = vec3(
        target_rec2020[0] / d65_rec2020[0],
        target_rec2020[1] / d65_rec2020[1],
        target_rec2020[2] / d65_rec2020[2]
    );
    float g = max(gain[1], 1e-6);
    return vec3(gain[0] / g, 1.0, gain[2] / g);
}

void main() {
    vec4 color = texture(uSrc, vTexCoord);

    // Identity short-circuit when live == decoded (per WhiteBalance.metal:94-95).
    if (abs(uLiveTemperature - uDecodedTemperature) < 0.5
     && abs(uLiveTint - uDecodedTint) < 0.5) {
        outColor = color;
        return;
    }

    vec3 g_live    = wb_gains(uLiveTemperature, uLiveTint);
    vec3 g_decoded = wb_gains(uDecodedTemperature, uDecodedTint);
    vec3 ratio = vec3(
        g_live[0] / max(g_decoded[0], 1e-6),
        g_live[1] / max(g_decoded[1], 1e-6),
        g_live[2] / max(g_decoded[2], 1e-6)
    );
    outColor = vec4(color.rgb * ratio, color.a);
}
