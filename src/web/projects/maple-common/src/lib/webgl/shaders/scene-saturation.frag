#version 300 es
// SceneSaturation.frag — port of SceneSaturation.metal:53-63 (Plan 3 M2.1).
//
// Uniform chroma scale in Oklab. No skin-tone protection (vibrance has
// it; saturation is meant to be uniform).
//
// Matrices duplicated from scene-vibrance.frag — see SceneSaturation.metal:11-16
// for the rationale (per-metallib symbol scoping; GLSL has the same
// restriction across separate compilation units).

precision highp float;

in  vec2 vTexCoord;
out vec4 outColor;

uniform sampler2D uSrc;
uniform float uSaturation;  // -100..+100

const mat3 M_rec2020_to_lms_sat = mat3(
    vec3(0.6370481, 0.2657101, 0.0365291),
    vec3(0.3320989, 0.6936245, 0.0374060),
    vec3(0.0002832, 0.0182337, 0.9994374)
);

const mat3 M_lms_to_oklab_sat = mat3(
    vec3(0.2104542553,  0.7936177850, -0.0040720468),
    vec3(1.9779984951, -2.4285922050,  0.4505937099),
    vec3(0.0259040371,  0.7827717662, -0.8086757660)
);

const mat3 M_oklab_to_lms_sat = mat3(
    vec3(1.0000000000,  1.0000000000,  1.0000000000),
    vec3(0.3963377774, -0.1055613458, -0.0894841775),
    vec3(0.2158037573, -0.0638541728, -1.2914855480)
);

const mat3 M_lms_to_rec2020_sat = mat3(
    vec3( 1.6970305, -0.5065012, -0.0247447),
    vec3(-0.7288047,  1.6510782,  0.0438581),
    vec3( 0.0413840, -0.0577547,  1.0759636)
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
