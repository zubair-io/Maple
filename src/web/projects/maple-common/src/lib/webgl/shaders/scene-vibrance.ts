// scene-vibrance.ts — port of SceneVibrance.metal:57-82 (Plan 3 M2.1).
// GLSL ES 3.0 fragment shader source as a TypeScript template literal.

export const SCENE_VIBRANCE_FRAGMENT_SOURCE = /* glsl */ `#version 300 es
// SceneVibrance.frag — port of SceneVibrance.metal:57-82.
//
// Oklab-based vibrance with skin-tone protection. Mirrors vibrance.rs.
// Matrices: Björn Ottosson Oklab (2020), composed with M_REC2020_TO_SRGB
// to match Rust's canonical chain in
// src/raw-pipeline/raw-core/src/color/oklab.rs. As of Ticket 12
// follow-up, bit-for-bit equivalent to Rust (replaces the previous
// Bradford-style direct rec2020->LMS values that disagreed with Rust
// on low-chroma hue direction). See SceneSaturation.metal header for
// full derivation.
//
// Duplicated in scene-saturation.ts; identical bit pattern.
//
// TODO codegen: lift these four matrices into src/scripts/codegen/ once
// the scaffold lands. Today all three platforms hold these by hand.
//
// Matrix layout: GLSL mat3(c0, c1, c2) takes COLUMNS, and the shader
// uses M*v form, so each vec3 arg below is a COLUMN of the math
// matrix. (Apple's Metal sibling uses ROW form because Metal uses
// v*M — same math matrix, different arg orientation.)

precision highp float;

in  vec2 vTexCoord;
out vec4 outColor;

uniform sampler2D uSrc;
uniform float uVibrance;  // -100..+100

const float M_PI_F = 3.14159265359;

// M_rec2020_to_lms = M1_SRGB_TO_LMS @ M_REC2020_TO_SRGB. vec3 args are COLUMNS.
const mat3 M_rec2020_to_lms = mat3(
    vec3( 0.61673040,  0.26509597,  0.10005846),
    vec3( 0.36021433,  0.63584589,  0.20389689),
    vec3( 0.02309135,  0.09906860,  0.69599049)
);

// M_lms_to_oklab = M2_LMS_TO_LAB (Bottosson 2020). vec3 args are COLUMNS.
const mat3 M_lms_to_oklab = mat3(
    vec3( 0.2104542553,  1.9779984951,  0.0259040371),
    vec3( 0.7936177850, -2.4285922050,  0.7827717662),
    vec3(-0.0040720468,  0.4505937099, -0.8086757660)
);

// M_oklab_to_lms = inverse(M2_LMS_TO_LAB). vec3 args are COLUMNS.
const mat3 M_oklab_to_lms = mat3(
    vec3(1.0000000000,  1.0000000000,  1.0000000000),
    vec3(0.3963377774, -0.1055613458, -0.0894841775),
    vec3(0.2158037573, -0.0638541728, -1.2914855480)
);

// M_lms_to_rec2020 = inverse(M_REC2020_TO_SRGB) @ inverse(M1_SRGB_TO_LMS).
// vec3 args are COLUMNS.
const mat3 M_lms_to_rec2020 = mat3(
    vec3( 2.13995843, -0.88463381, -0.04848752),
    vec3(-1.24643838,  2.16319054, -0.45453369),
    vec3( 0.10642154, -0.27856253,  1.50310914)
);

vec3 rec2020_to_oklab(vec3 rgb) {
    vec3 lms = M_rec2020_to_lms * rgb;
    vec3 lms_nl = sign(lms) * pow(abs(lms), vec3(1.0 / 3.0));
    return M_lms_to_oklab * lms_nl;
}

vec3 oklab_to_rec2020(vec3 lab) {
    vec3 lms_nl = M_oklab_to_lms * lab;
    vec3 lms = lms_nl * lms_nl * lms_nl;
    return M_lms_to_rec2020 * lms;
}

void main() {
    vec4 color = texture(uSrc, vTexCoord);

    if (abs(uVibrance) < 1e-3) {
        outColor = color;
        return;
    }

    float amount = uVibrance / 100.0;
    vec3 lab = rec2020_to_oklab(color.rgb);
    float L = lab[0], a = lab[1], b = lab[2];
    float chroma = sqrt(a * a + b * b);

    if (chroma < 1e-6) {
        outColor = color;
        return;
    }

    float hue_deg = atan(b, a) * (180.0 / M_PI_F);
    float skin_mask = smoothstep(15.0, 22.0, hue_deg)
                    * (1.0 - smoothstep(35.0, 42.0, hue_deg));
    float low_chroma_factor = 1.0 - clamp(chroma / 0.3, 0.0, 1.0);
    float chroma_boost = low_chroma_factor * amount * (1.0 - skin_mask * 0.6);
    float scale = 1.0 + chroma_boost;

    vec3 new_lab = vec3(L, a * scale, b * scale);
    vec3 rgb_out = oklab_to_rec2020(new_lab);
    outColor = vec4(rgb_out, color.a);
}
`;
