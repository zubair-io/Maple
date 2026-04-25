// scene-tone-controls.ts — port of SceneToneControls.metal:25-75 (Plan 3 M2.1).
// GLSL ES 3.0 fragment shader source as a TypeScript template literal.

export const SCENE_TONE_CONTROLS_FRAGMENT_SOURCE = /* glsl */ `#version 300 es
// SceneToneControls.frag — port of SceneToneControls.metal:25-75.
//
// Input: scene-linear Rec.2020 from the WB stage.
// Five tone parameters: exposure (EV), highlights, shadows, whites, blacks
// (each -100..100, contrast lives in AgX).
//
// Mirrors src/apple/.../Metal/SceneToneControls.metal:25-75.

precision highp float;

in  vec2 vTexCoord;
out vec4 outColor;

uniform sampler2D uSrc;
uniform float uExposure;    // -4..+4 EV
uniform float uHighlights;  // -100..+100
uniform float uShadows;     // -100..+100
uniform float uWhites;      // -100..+100
uniform float uBlacks;      // -100..+100

// Rec.2020 luminance coefficients — matches LUMA_REC2020 in
// SceneToneControls.metal:18 (also matches Rust LUMA_REC2020 array).
const vec3 LUMA_REC2020 = vec3(0.2627, 0.6780, 0.0593);

void main() {
    vec4 color = texture(uSrc, vTexCoord);
    vec3 p = color.rgb;

    // 1. Exposure: p *= 2^ev
    if (abs(uExposure) >= 1e-6) {
        float gain = exp2(uExposure);
        p *= gain;
    }

    // 2. Highlights — soft compression above knee = 1.0 (per metal:42-50).
    if (abs(uHighlights) >= 1e-3) {
        float h_amount = uHighlights / 100.0;
        float h_denom = 1.0 + h_amount * 2.0;
        if (abs(h_denom) > 1e-6) {
            if (p.r > 1.0) p.r = 1.0 + (p.r - 1.0) / h_denom;
            if (p.g > 1.0) p.g = 1.0 + (p.g - 1.0) / h_denom;
            if (p.b > 1.0) p.b = 1.0 + (p.b - 1.0) / h_denom;
        }
    }

    // 3. Shadows — luminance-masked lift of deep values (per metal:53-60).
    // GLSL smoothstep(e0, e1, x) matches Apple's smoothstep_f exactly
    // (same Hermite definition, same clamp).
    if (abs(uShadows) >= 1e-3) {
        float luma = dot(p, LUMA_REC2020);
        float mask = 1.0 - smoothstep(0.0, 0.1, luma);
        float s_factor = (uShadows / 100.0) * 0.5;
        float lift = mask * s_factor;
        p += p * lift;
    }

    // 4. Whites — small scalar gain near diffuse white (per metal:63-66).
    if (abs(uWhites) >= 1e-3) {
        float w_gain = 1.0 + uWhites / 200.0;
        p *= w_gain;
    }

    // 5. Blacks — linear shift; can go negative in scene-linear (per metal:69-72).
    if (abs(uBlacks) >= 1e-3) {
        float b_add = uBlacks / 400.0;
        p += b_add;
    }

    outColor = vec4(p, color.a);
}
`;
