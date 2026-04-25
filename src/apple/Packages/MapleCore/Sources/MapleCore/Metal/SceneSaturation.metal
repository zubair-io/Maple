// SceneSaturation.metal — CIColorKernel that mirrors the Rust
// saturation.rs stage (spec § 3.7).
//
// Input: scene-linear Rec.2020 pixel.
// Parameter: saturation in [-100, +100]. 0 -> identity. -100 -> fully
// achromatic. +100 -> 2x chroma. No skin-tone protection (vibrance
// has it; saturation is meant to be uniform).

#include <CoreImage/CoreImage.h>

// Oklab matrices -- verbatim copy from SceneVibrance.metal. Metal does
// not share constants between .metal files inside a single metallib;
// repeating them here is the right pattern. If either file's matrices
// change, both must be updated together (and the Rust constants in
// `color::oklab` along with them). The `_sat` suffix avoids any
// cross-file symbol-resolution ambiguity inside the metallib.
constant float3x3 M_rec2020_to_lms_sat = float3x3(
    float3(0.6370481, 0.2657101, 0.0365291),
    float3(0.3320989, 0.6936245, 0.0374060),
    float3(0.0002832, 0.0182337, 0.9994374)
);

constant float3x3 M_lms_to_oklab_sat = float3x3(
    float3(0.2104542553, 0.7936177850, -0.0040720468),
    float3(1.9779984951, -2.4285922050, 0.4505937099),
    float3(0.0259040371, 0.7827717662, -0.8086757660)
);

constant float3x3 M_oklab_to_lms_sat = float3x3(
    float3(1.0000000000, 0.3963377774, 0.2158037573),
    float3(1.0000000000, -0.1055613458, -0.0638541728),
    float3(1.0000000000, -0.0894841775, -1.2914855480)
);

constant float3x3 M_lms_to_rec2020_sat = float3x3(
    float3(1.6970305, -0.7288047, 0.0413840),
    float3(-0.5065012, 1.6510782, -0.0577547),
    float3(-0.0247447, 0.0438581, 1.0759636)
);

float3 rec2020_to_oklab_sat(float3 rgb) {
    float3 lms = M_rec2020_to_lms_sat * rgb;
    float3 lms_nl = sign(lms) * pow(abs(lms), float3(1.0 / 3.0));
    return M_lms_to_oklab_sat * lms_nl;
}

float3 oklab_to_rec2020_sat(float3 lab) {
    float3 lms_nl = M_oklab_to_lms_sat * lab;
    float3 lms = lms_nl * lms_nl * lms_nl;
    return M_lms_to_rec2020_sat * lms;
}

extern "C" float4 sceneSaturation(
    coreimage::sampler_h src,
    float saturation
) {
    float4 color = src.sample(src.coord());
    if (abs(saturation) < 1e-3) return color;
    float scale = 1.0 + saturation / 100.0;
    float3 lab = rec2020_to_oklab_sat(color.rgb);
    float3 new_lab = float3(lab[0], lab[1] * scale, lab[2] * scale);
    return float4(oklab_to_rec2020_sat(new_lab), color.a);
}
