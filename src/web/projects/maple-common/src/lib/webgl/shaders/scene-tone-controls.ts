// scene-tone-controls.ts — GLSL mirror of the Rust core scene_tone_controls stage.
// GLSL ES 3.0 fragment shader source as a TypeScript template literal.
//
// Apple uses the same Rust core via FFI — there is no Metal shader for this
// stage. The Rust reference is the source of truth; this shader must match
// it within the 1e-4 parity gate (CLAUDE.md § "Parity before features").

export const SCENE_TONE_CONTROLS_FRAGMENT_SOURCE = /* glsl */ `#version 300 es
// SceneToneControls.frag — mirror of
// src/raw-pipeline/raw-core/src/stages/scene_tone_controls.rs.
//
// Input: scene-linear Rec.2020 from the WB stage.
// Five tone parameters: exposure (EV), highlights, shadows, whites, blacks
// (each -100..100, contrast lives in AgX).

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
// scene_tone_controls.rs:6 (also matches Apple FFI path's constant).
const vec3 LUMA_REC2020 = vec3(0.2627, 0.6780, 0.0593);

void main() {
    vec4 color = texture(uSrc, vTexCoord);
    vec3 p = color.rgb;

    // 1. Exposure: p *= 2^ev
    if (abs(uExposure) >= 1e-6) {
        float gain = exp2(uExposure);
        p *= gain;
    }

    // 2. Highlights — luminance-coupled soft compression above knee=1.0
    //    (Ticket #266). The legacy per-channel compression introduced a
    //    hue rotation on saturated specular highlights (one channel
    //    above knee, others below → only one channel compressed → R:G:B
    //    drift). Computing Y, compressing Y, scaling RGB by Y_new/Y_old
    //    preserves hue: only operation on RGB is a uniform multiply.
    if (abs(uHighlights) >= 1e-3) {
        float h_amount = uHighlights / 100.0;
        float h_denom = 1.0 + h_amount * 2.0;
        if (abs(h_denom) > 1e-6) {
            float y_old = dot(p, LUMA_REC2020);
            // Y must exceed the knee to compress; tiny-positive Y values
            // are pathological — skip defensively.
            if (y_old > 1.0 && y_old > 1e-6) {
                float y_new = 1.0 + (y_old - 1.0) / h_denom;
                float scale = y_new / y_old;
                p *= scale;
            }
        }
    }

    // 3. Shadows — luminance-masked lift of deep values (per rs:64-71).
    // GLSL smoothstep(e0, e1, x) matches Rust's smoothstep_f exactly
    // (same Hermite definition, same clamp).
    if (abs(uShadows) >= 1e-3) {
        float luma = dot(p, LUMA_REC2020);
        float mask = 1.0 - smoothstep(0.0, 0.1, luma);
        float s_factor = (uShadows / 100.0) * 0.5;
        float lift = mask * s_factor;
        p += p * lift;
    }

    // 4. Whites — smoothstep-weighted gain near the diffuse-white
    //    endpoint (Ticket #267). The legacy "1 + whites/200" scalar
    //    gain brightened mid-gray; weighting by smoothstep(0.5, 1.0, Y)
    //    leaves midtones alone and concentrates the action near
    //    diffuse white.
    if (abs(uWhites) >= 1e-3) {
        float y_old = dot(p, LUMA_REC2020);
        float w = smoothstep(0.5, 1.0, y_old);
        float w_gain = 1.0 + (uWhites / 200.0) * w;
        p *= w_gain;
    }

    // 5. Blacks — smoothstep-weighted parametric toe (Ticket #268).
    //    Legacy: additive shift floored at 0 — produced a hard floor on
    //    negative blacks (Bug A regression fix in #135).
    //
    //    New: weight by w = 1 - smoothstep(0, 0.2, Y) so midtones are
    //    untouched. Negative blacks crush multiplicatively (no negative
    //    scene values possible), positive blacks lift additively
    //    (preserves legacy zero-input → 0.25 at blacks=+100).
    if (abs(uBlacks) >= 1e-3) {
        float y_old = dot(p, LUMA_REC2020);
        float w = 1.0 - smoothstep(0.0, 0.2, y_old);
        if (uBlacks < 0.0) {
            float b_amount = uBlacks / 100.0; // -1..0
            float factor = 1.0 + b_amount * w;
            p *= factor;
        } else {
            float delta = (uBlacks / 400.0) * w;
            p += vec3(delta);
        }
    }

    outColor = vec4(p, color.a);
}
`;
