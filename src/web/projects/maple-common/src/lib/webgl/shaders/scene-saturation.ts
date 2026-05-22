// scene-saturation.ts — port of SceneSaturation.metal:53-63 (Plan 3 M2.1).
// GLSL ES 3.0 fragment shader source as a TypeScript template literal.

export const SCENE_SATURATION_FRAGMENT_SOURCE = /* glsl */ `#version 300 es
// SceneSaturation.frag — port of SceneSaturation.metal:53-63 +
// gamut-aware soft-clip (#269).
//
// Uniform chroma scale in Oklab. No skin-tone protection (vibrance has
// it; saturation is meant to be uniform). After the chroma scale, if any
// Rec.2020 channel would go negative the chroma is soft-compressed back
// along the same hue line (Oklab atan2 angle preserved) toward the gamut
// hull. Mirrors src/raw-pipeline/raw-core/src/stages/saturation.rs —
// constants and iteration counts MUST stay in lock-step with the Rust
// source for the 1e-4 cross-platform parity gate.
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

// Gamut-clip constants (#269). MUST stay in lock-step with the Rust source
// (src/raw-pipeline/raw-core/src/stages/saturation.rs) — the per-channel
// 1e-4 parity gate depends on it.
const float GAMUT_KNEE_FRACTION = 0.8;
const int   GAMUT_BISECT_ITERS  = 24;
const float GAMUT_EPS           = 1e-5;

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

// Largest chroma along the (L, a_hat, b_hat) ray whose Rec.2020
// projection has min channel >= -GAMUT_EPS. Caller has verified that
// c_high is out of gamut; c_low = 0 is always in gamut (neutral grey
// at any L is renderable). Mirrors bisect_gamut_hull() in Rust.
float bisect_gamut_hull(float l, float a_hat, float b_hat, float c_high) {
    float lo = 0.0;
    float hi = c_high;
    for (int i = 0; i < GAMUT_BISECT_ITERS; i++) {
        float mid = 0.5 * (lo + hi);
        vec3 rgb = oklab_to_rec2020_sat(vec3(l, a_hat * mid, b_hat * mid));
        float min_c = min(min(rgb.r, rgb.g), rgb.b);
        if (min_c >= -GAMUT_EPS) {
            lo = mid;
        } else {
            hi = mid;
        }
    }
    return lo;
}

// Reinhard-style soft compression: identity below GAMUT_KNEE_FRACTION *
// c_hull, smooth asymptote to c_hull above. C¹ at the knee. Mirrors
// soft_compress() in Rust.
float soft_compress(float c_target, float c_hull) {
    float c_thresh = GAMUT_KNEE_FRACTION * c_hull;
    if (c_target <= c_thresh) {
        return c_target;
    }
    float d = c_target - c_thresh;
    float d_max = c_hull - c_thresh;
    if (d_max <= 0.0) {
        return c_hull;
    }
    return c_thresh + d_max * (d / (d + d_max));
}

void main() {
    vec4 color = texture(uSrc, vTexCoord);
    if (abs(uSaturation) < 1e-3) {
        outColor = color;
        return;
    }
    float scale = 1.0 + uSaturation / 100.0;
    vec3 lab = rec2020_to_oklab_sat(color.rgb);
    float l = lab[0];
    float a = lab[1];
    float b = lab[2];
    float c_in = sqrt(a * a + b * b);

    // Near-neutral pixel: chroma is zero, scaling is a no-op.
    if (c_in < 1e-6) {
        outColor = color;
        return;
    }

    float c_target = c_in * scale;
    float a_hat = a / c_in;
    float b_hat = b / c_in;

    // Desaturation can never push a channel further negative than the
    // original pixel, so skip the gamut check.
    if (scale <= 1.0) {
        outColor = vec4(oklab_to_rec2020_sat(vec3(l, a_hat * c_target, b_hat * c_target)), color.a);
        return;
    }

    // Fast path: most pixels at moderate +saturation are far enough
    // inside the hull that the naive scaled result is already valid.
    vec3 lab_target = vec3(l, a_hat * c_target, b_hat * c_target);
    vec3 rgb_target = oklab_to_rec2020_sat(lab_target);
    float min_target = min(min(rgb_target.r, rgb_target.g), rgb_target.b);
    if (min_target >= -GAMUT_EPS) {
        outColor = vec4(rgb_target, color.a);
        return;
    }

    // Bisect for the hull, soft-compress toward it. Never reduce chroma
    // below the input — saturation is monotone non-decreasing in chroma
    // for scale >= 1.
    float c_hull = bisect_gamut_hull(l, a_hat, b_hat, c_target);
    float c_floor = min(c_in, c_hull);
    float c_out = max(soft_compress(c_target, c_hull), c_floor);
    outColor = vec4(oklab_to_rec2020_sat(vec3(l, a_hat * c_out, b_hat * c_out)), color.a);
}
`;
