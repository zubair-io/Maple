// scene-saturation.ts — port of SceneSaturation.metal:53-63 (Plan 3 M2.1).
// GLSL ES 3.0 fragment shader source as a TypeScript template literal.

export const SCENE_SATURATION_FRAGMENT_SOURCE = /* glsl */ `#version 300 es
// SceneSaturation.frag — port of SceneSaturation.metal:53-63.
//
// Uniform chroma scale in Oklab. No skin-tone protection (vibrance has
// it; saturation is meant to be uniform).
//
// Matrices duplicated from scene-vibrance.ts — see SceneSaturation.metal
// header for the rationale (per-metallib symbol scoping; GLSL has the
// same restriction across separate compilation units).
//
// As of Ticket 12 follow-up, the matrices are bit-for-bit equivalent
// to Rust's canonical Oklab chain in
// src/raw-pipeline/raw-core/src/color/oklab.rs — precomputed products
// of Bottosson M1/M2 with M_REC2020_TO_SRGB. See SceneSaturation.metal
// header for full derivation.
//
// TODO codegen: lift these four matrices into src/scripts/codegen/ once
// the scaffold lands. Today all three platforms hold these by hand.
//
// Matrix layout note: GLSL mat3(c0, c1, c2) takes COLUMNS, and the
// shader uses M*v form, so each vec3 arg below is a COLUMN of the
// math matrix. (Apple's Metal sibling uses ROW form because Metal
// uses v*M — same math matrix, different arg orientation.)

precision highp float;

in  vec2 vTexCoord;
out vec4 outColor;

uniform sampler2D uSrc;
uniform float uSaturation;  // -100..+100

// M_rec2020_to_lms_sat = M1_SRGB_TO_LMS @ M_REC2020_TO_SRGB
// (numpy float64, rounded to 8 sig figs). vec3 args are COLUMNS.
const mat3 M_rec2020_to_lms_sat = mat3(
    vec3( 0.61673040,  0.26509597,  0.10005846),
    vec3( 0.36021433,  0.63584589,  0.20389689),
    vec3( 0.02309135,  0.09906860,  0.69599049)
);

// M_lms_to_oklab_sat = M2_LMS_TO_LAB (Bottosson 2020). vec3 args are COLUMNS.
const mat3 M_lms_to_oklab_sat = mat3(
    vec3( 0.2104542553,  1.9779984951,  0.0259040371),
    vec3( 0.7936177850, -2.4285922050,  0.7827717662),
    vec3(-0.0040720468,  0.4505937099, -0.8086757660)
);

// M_oklab_to_lms_sat = inverse(M2_LMS_TO_LAB). vec3 args are COLUMNS.
const mat3 M_oklab_to_lms_sat = mat3(
    vec3(1.0000000000,  1.0000000000,  1.0000000000),
    vec3(0.3963377774, -0.1055613458, -0.0894841775),
    vec3(0.2158037573, -0.0638541728, -1.2914855480)
);

// M_lms_to_rec2020_sat = inverse(M_REC2020_TO_SRGB) @ inverse(M1_SRGB_TO_LMS).
// vec3 args are COLUMNS.
const mat3 M_lms_to_rec2020_sat = mat3(
    vec3( 2.13995843, -0.88463381, -0.04848752),
    vec3(-1.24643838,  2.16319054, -0.45453369),
    vec3( 0.10642154, -0.27856253,  1.50310914)
);

vec3 rec2020_to_oklab_sat(vec3 rgb) {
    vec3 lms = M_rec2020_to_lms_sat * rgb;
    vec3 lms_nl = sign(lms) * pow(abs(lms), vec3(1.0 / 3.0));
    return M_lms_to_oklab_sat * lms_nl;
}

vec3 oklab_to_rec2020_sat(vec3 lab) {
    vec3 lms_nl = M_oklab_to_lms_sat * lab;
    vec3 lms = lms_nl * lms_nl * lms_nl;
    return M_lms_to_rec2020_sat * lms;
}

void main() {
    vec4 color = texture(uSrc, vTexCoord);
    if (abs(uSaturation) < 1e-3) {
        outColor = color;
        return;
    }
    float scale = 1.0 + uSaturation / 100.0;
    vec3 lab = rec2020_to_oklab_sat(color.rgb);
    vec3 new_lab = vec3(lab[0], lab[1] * scale, lab[2] * scale);
    outColor = vec4(oklab_to_rec2020_sat(new_lab), color.a);
}
`;
