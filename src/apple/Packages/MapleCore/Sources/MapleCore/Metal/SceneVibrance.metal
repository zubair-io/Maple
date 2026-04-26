// SceneVibrance.metal — Oklab-based vibrance with skin-tone protection
// (spec § 3.7). Mirrors vibrance.rs.
//
// Oklab conversion for Rec.2020:
//   - Transform to LMS via M_rec2020_to_lms matrix
//   - Non-linear LMS^(1/3)
//   - L*a*b via M_lms_to_oklab matrix
//
// The skin-tone window is the hue range [15°, 42°] in Oklab with 60%
// attenuation (same as Rust spec values).

#include <CoreImage/CoreImage.h>

// Rec.2020 to LMS (Björn Ottosson Oklab, 2020).
// From: https://bottosson.github.io/posts/oklab/
//
// Each `float3` argument to `float3x3(...)` becomes a COLUMN of the
// resulting Metal matrix, but the values below are the ROWS of the
// math matrix (matching the Rust source's row-major layout). Using
// `v * M_metal` therefore produces `M_math * v` — see SceneSaturation
// header for the full Bug 2 / Ticket 12 explanation.
constant float3x3 M_rec2020_to_lms = float3x3(
    float3(0.6370481, 0.2657101, 0.0365291),
    float3(0.3320989, 0.6936245, 0.0374060),
    float3(0.0002832, 0.0182337, 0.9994374)
);

constant float3x3 M_lms_to_oklab = float3x3(
    float3(0.2104542553, 0.7936177850, -0.0040720468),
    float3(1.9779984951, -2.4285922050, 0.4505937099),
    float3(0.0259040371, 0.7827717662, -0.8086757660)
);

constant float3x3 M_oklab_to_lms = float3x3(
    float3(1.0000000000, 0.3963377774, 0.2158037573),
    float3(1.0000000000, -0.1055613458, -0.0638541728),
    float3(1.0000000000, -0.0894841775, -1.2914855480)
);

constant float3x3 M_lms_to_rec2020 = float3x3(
    float3(1.6970305, -0.7288047, 0.0413840),
    float3(-0.5065012, 1.6510782, -0.0577547),
    float3(-0.0247447, 0.0438581, 1.0759636)
);

float3 rec2020_to_oklab(float3 rgb) {
    float3 lms = rgb * M_rec2020_to_lms;
    float3 lms_nl = sign(lms) * pow(abs(lms), float3(1.0 / 3.0));
    return lms_nl * M_lms_to_oklab;
}

float3 oklab_to_rec2020(float3 lab) {
    float3 lms_nl = lab * M_oklab_to_lms;
    float3 lms = lms_nl * lms_nl * lms_nl;
    return lms * M_lms_to_rec2020;
}

float smoothstep_v(float e0, float e1, float x) {
    float t = clamp((x - e0) / (e1 - e0), 0.0, 1.0);
    return t * t * (3.0 - 2.0 * t);
}

[[stitchable]] float4 sceneVibrance(
    coreimage::sampler_h src,
    float vibrance   // -100..+100
) {
    float4 color = float4(src.sample(src.coord()));

    if (abs(vibrance) < 1e-3) return color;

    float amount = vibrance / 100.0;
    float3 lab = rec2020_to_oklab(color.rgb);
    float L = lab[0], a = lab[1], b = lab[2];
    float chroma = sqrt(a * a + b * b);

    if (chroma < 1e-6) return color; // near-neutral, nothing to do

    float hue_deg = atan2(b, a) * (180.0 / M_PI_F);
    float skin_mask = smoothstep_v(15.0, 22.0, hue_deg)
                    * (1.0 - smoothstep_v(35.0, 42.0, hue_deg));
    float low_chroma_factor = 1.0 - clamp(chroma / 0.3, 0.0, 1.0);
    float chroma_boost = low_chroma_factor * amount * (1.0 - skin_mask * 0.6);
    float scale = 1.0 + chroma_boost;

    float3 new_lab = float3(L, a * scale, b * scale);
    float3 rgb_out = oklab_to_rec2020(new_lab);
    return float4(rgb_out, color.a);
}
