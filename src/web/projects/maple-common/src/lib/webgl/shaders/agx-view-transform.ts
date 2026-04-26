// agx-view-transform.ts — Maple AgX (photography-tuned) GLSL fragment shader.
// GLSL ES 3.0 source as a TypeScript template literal.

export const AGX_VIEW_TRANSFORM_FRAGMENT_SOURCE = /* glsl */ `#version 300 es
// AgXViewTransform.frag — Maple AgX with INLINE polynomial.
//
// This is **Maple AgX** — photography-tuned, NOT Blender-faithful. The
// polynomial is fitted to ACR baseline renders so mid-gray is preserved
// (scene 0.18 → display ~0.25) instead of lifted to ~0.50 the way
// Blender's AgX_Default_Contrast places it.
//
// The polynomial coefficients are frozen and mirror:
//   * src/scripts/derive_agx_lut.py — the source of truth
//   * src/raw-pipeline/raw-core/src/view/agx_lut.bin (LUT-baked Rust port)
//   * src/apple/.../Metal/AgXViewTransform.metal (Apple inline port)
//
// Skipping the WebGL LUT bundling (Plan 3 M2.1 Task 8) in favour of inline
// sigmoid math — see plan execution notes for the Plan 3 M2 driver task.

precision highp float;

in  vec2 vTexCoord;
out vec4 outColor;

uniform sampler2D uSrc;
uniform float uContrast;    // -100..+100

const float AGX_MIN_EV   = -10.0;
const float AGX_MAX_EV   =   6.5;
const float AGX_MID_GRAY =   0.18;
const float MID_NORM     = 10.0 / 16.5;  // -AGX_MIN_EV / (AGX_MAX_EV - AGX_MIN_EV) ≈ 0.6061

// Per-channel log-encode: scene-linear -> normalized log position in [0, 1].
// Mirrors AgXViewTransform.metal's agx_log_encode.
float agx_log_encode(float linear) {
    float eps = 1e-10;
    float log_val = log2(max(linear, eps)) - log2(AGX_MID_GRAY);
    return clamp((log_val - AGX_MIN_EV) / (AGX_MAX_EV - AGX_MIN_EV), 0.0, 1.0);
}

// Inline Maple AgX sigmoid — photography-tuned 6th-order polynomial.
// 'x' is the normalized-log position in [0, 1]; output is display-linear in [0, 1].
//
// Coefficients mirror the Apple inline kernel and the Python source at
// src/scripts/derive_agx_lut.py — single source of truth.
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

// Apply contrast modulation: expand/compress around MID_NORM
// so contrast=0 → identity, +100 → steep sigmoid (spec § 3.6a).
// Mirrors AgXViewTransform.metal's apply_contrast.
float apply_contrast(float t, float contrast) {
    if (abs(contrast) < 1e-3) return t;
    float s = 1.0 + contrast / 200.0;
    float shifted = (t - MID_NORM) * s + MID_NORM;
    return clamp(shifted, 0.0, 1.0);
}

void main() {
    vec4 color = texture(uSrc, vTexCoord);
    vec3 p = color.rgb;

    vec3 log_encoded = vec3(
        agx_log_encode(p.r),
        agx_log_encode(p.g),
        agx_log_encode(p.b)
    );

    log_encoded = vec3(
        apply_contrast(log_encoded.r, uContrast),
        apply_contrast(log_encoded.g, uContrast),
        apply_contrast(log_encoded.b, uContrast)
    );

    vec3 display = vec3(
        agx_sigmoid(log_encoded.r),
        agx_sigmoid(log_encoded.g),
        agx_sigmoid(log_encoded.b)
    );

    outColor = vec4(display, color.a);
}
`;
