#version 300 es
// SceneVibrance.frag — port of SceneVibrance.metal:57-82 (Plan 3 M2.1).
//
// Oklab-based vibrance with skin-tone protection. Mirrors vibrance.rs.
// Matrices: Björn Ottosson Oklab (2020) — duplicated in
// scene-saturation.frag; identical bit pattern. M2.3 codegen plan
// hoists these to a shared GLSL include.
//
// Both Metal `float3x3(c0, c1, c2)` and GLSL `mat3(c0, c1, c2)` take
// columns. To match Apple's runtime M*v exactly we pass the same
// `vec3` arguments Apple's `float3x3` constructor takes — see the
// matching note in white-balance.frag.

precision highp float;

in  vec2 vTexCoord;
out vec4 outColor;

uniform sampler2D uSrc;
uniform float uVibrance;  // -100..+100

const float M_PI_F = 3.14159265359;

// Rec.2020 to LMS — vec3 args mirror SceneVibrance.metal:16-20 byte-for-byte.
const mat3 M_rec2020_to_lms = mat3(
    vec3(0.6370481, 0.2657101, 0.0365291),
    vec3(0.3320989, 0.6936245, 0.0374060),
    vec3(0.0002832, 0.0182337, 0.9994374)
);

// LMS to Oklab — mirrors SceneVibrance.metal:22-26.
const mat3 M_lms_to_oklab = mat3(
    vec3(0.2104542553,  0.7936177850, -0.0040720468),
    vec3(1.9779984951, -2.4285922050,  0.4505937099),
    vec3(0.0259040371,  0.7827717662, -0.8086757660)
);

// Oklab to LMS — mirrors SceneVibrance.metal:28-32.
const mat3 M_oklab_to_lms = mat3(
    vec3(1.0000000000,  1.0000000000,  1.0000000000),
    vec3(0.3963377774, -0.1055613458, -0.0894841775),
    vec3(0.2158037573, -0.0638541728, -1.2914855480)
);

// LMS to Rec.2020 — mirrors SceneVibrance.metal:34-38.
const mat3 M_lms_to_rec2020 = mat3(
    vec3( 1.6970305, -0.5065012, -0.0247447),
    vec3(-0.7288047,  1.6510782,  0.0438581),
    vec3( 0.0413840, -0.0577547,  1.0759636)
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
