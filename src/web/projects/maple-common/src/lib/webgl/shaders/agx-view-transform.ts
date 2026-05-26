// agx-view-transform.ts — Maple AgX GLSL fragment shader.
// Post-#435: inset matrix → log encode → ratio-preserving Jed Smith
// sigmoid (norm = max(R,G,B); sigmoid the norm, scale RGB by
// sigmoid/norm) → outset matrix → Oklab hue-preserving gamut
// compression to [0, 1]^3. Replaces the pre-#435 per-channel sigmoid
// + hard `clamp(0,1)` form, which surfaced magenta on saturated
// reds/blues/purples.
//
// GLSL ES 3.0 source as a TypeScript template literal.
//
// All constants are the single source of truth from
// `src/scripts/derive_agx_lut.py` and mirror:
//   * src/raw-pipeline/raw-core/src/view/agx_coeffs.rs (Rust port)
//   * src/raw-pipeline/raw-core/src/view/agx_lut.bin   (Rust LUT)
//
// Cross-platform parity is split across two test boundaries:
//   * Rust↔GLSL byte-equality at 1e-4 per LUT index is enforced by
//     `glsl_port_matches_rust_lut` in
//     `src/raw-pipeline/raw-core/src/view/agx.rs` — it ports this
//     GLSL sigmoid math into Rust and diffs against every entry of
//     `agx_lut.bin`. Run via `cargo test -p raw-core --lib`.
//   * GLSL self-consistency (pivot exactness, monotonicity, endpoint
//     anchors) is enforced by `agx-view-transform.parity.spec.ts`.
// Splitting the boundary this way avoids needing node:fs / Node types
// in the jsdom Angular spec environment.

export const AGX_VIEW_TRANSFORM_FRAGMENT_SOURCE = /* glsl */ `#version 300 es
// AgXViewTransform.frag — canonical Sobotka AgX with inline matrices + sigmoid.

precision highp float;

in  vec2 vTexCoord;
out vec4 outColor;

uniform sampler2D uSrc;
uniform float uContrast;    // -100..+100

// ── Log-encode domain ────────────────────────────────────────────────────
const float AGX_MIN_EV   = -10.0;
const float AGX_MAX_EV   =   6.5;
const float AGX_MID_GRAY =   0.18;
// MID_NORM = -AGX_MIN_EV / (AGX_MAX_EV - AGX_MIN_EV) = 10 / 16.5 ≈ 0.60606
const float AGX_MID_NORM = 10.0 / 16.5;

// ── Jed Smith / Sobotka sigmoid parameters ───────────────────────────────
const float AGX_X_PIVOT      = AGX_MID_NORM;     // ≈ 0.6060606
const float AGX_Y_PIVOT      = 0.18;             // Maple photography-tuned
const float AGX_SLOPE        = 2.4;              // see agx_coeffs.rs feasibility note
const float AGX_TOE_POWER    = 3.0;
const float AGX_SHOULDER_POWER = 3.25;

// ── Inset / outset matrices (Rec.2020 ↔ AgX-Base-Rec.2020) ───────────────
// GLSL is column-major; supply the constants as the transpose of the
// Rust row-major matrices so \`AGX_INSET * v\` gives the same result.
//
// Rust AGX_INSET_MATRIX rows are the rows of the matrix; GLSL mat3
// constructor takes columns. So:
//   col0 = column 0 of the row-major matrix = M[0][0], M[1][0], M[2][0]
const mat3 AGX_INSET = mat3(
    0.8591975135, 0.0591975135, 0.0591975135,   // col 0 = M[*][0]
    0.0559752486, 0.8559752486, 0.0559752486,   // col 1 = M[*][1]
    0.0848272379, 0.0848272379, 0.8848272379    // col 2 = M[*][2]
);

const mat3 AGX_OUTSET = mat3(
    1.1760031081, -0.0739968919, -0.0739968919, // col 0
   -0.0699690607,  1.1800309393, -0.0699690607, // col 1
   -0.1060340474, -0.1060340474,  1.1439659526  // col 2
);

// Per-channel log2-encode + normalize to [0, 1].
float agx_log_encode(float linear) {
    float floor_v = AGX_MID_GRAY * exp2(AGX_MIN_EV);
    float clamped = max(linear, floor_v);
    float log_v = clamp(log2(clamped / AGX_MID_GRAY), AGX_MIN_EV, AGX_MAX_EV);
    return (log_v - AGX_MIN_EV) / (AGX_MAX_EV - AGX_MIN_EV);
}

// ── Oklab matrices (Ottosson 2020) ───────────────────────────────────────
// Used by oklab_gamut_compress to bisect chroma at constant L. Rec.2020 ↔
// linear sRGB ↔ LMS ↔ Lab. GLSL mat3 is column-major; matrices below are
// transposed relative to their row-major Rust mirrors.
const mat3 M_REC2020_TO_SRGB = mat3(
    1.6605, -0.1246, -0.0182,
   -0.5876,  1.1329, -0.1006,
   -0.0728, -0.0083,  1.1187
);
const mat3 M_SRGB_TO_REC2020 = mat3(
    0.6274, 0.0691, 0.0164,
    0.3293, 0.9195, 0.0880,
    0.0433, 0.0114, 0.8956
);
const mat3 M1_SRGB_TO_LMS = mat3(
    0.41222147, 0.21190350, 0.08830246,
    0.53633254, 0.68069955, 0.28171884,
    0.05144599, 0.10739696, 0.62997870
);
const mat3 M2_LMS_TO_LAB = mat3(
     0.21045426,  1.97799850,  0.02590404,
     0.79361779, -2.42859221,  0.78277177,
    -0.00407205,  0.45059371, -0.80867577
);
// Pre-baked inverses (computed by src/scripts/derive_agx_lut.py mirroring
// agx_hue_restoration.rs).
const mat3 M2_LAB_TO_LMS = mat3(
    1.00000000, 1.00000000, 1.00000000,
    0.39633777, -0.10556134, -0.08948418,
    0.21580376, -0.06385417, -1.29148555
);
const mat3 M1_LMS_TO_SRGB = mat3(
     4.07674166, -1.26843593, -0.00419608,
    -3.30771159,  2.60975740, -0.70341861,
     0.23096993, -0.34131938,  1.70761470
);

vec3 rec2020_to_oklab(vec3 rgb) {
    vec3 lin_srgb = M_REC2020_TO_SRGB * rgb;
    vec3 lms = M1_SRGB_TO_LMS * lin_srgb;
    vec3 lms_cube = sign(lms) * pow(abs(lms), vec3(1.0 / 3.0));
    return M2_LMS_TO_LAB * lms_cube;
}

vec3 oklab_to_rec2020(vec3 lab) {
    vec3 lms_cube = M2_LAB_TO_LMS * lab;
    vec3 lms = lms_cube * lms_cube * lms_cube;
    vec3 lin_srgb = M1_LMS_TO_SRGB * lms;
    return M_SRGB_TO_REC2020 * lin_srgb;
}

bool in_unit_box(vec3 rgb) {
    return all(greaterThanEqual(rgb, vec3(-1.0e-5)))
        && all(lessThanEqual(rgb, vec3(1.0 + 1.0e-5)));
}

// Hue-preserving gamut compression — bisect Oklab chroma toward 0 at
// constant L until the Rec.2020 round-trip is in [0, 1]^3. Mirrors
// agx_hue_restoration::oklab_gamut_compress.
vec3 oklab_gamut_compress(vec3 rgb) {
    if (in_unit_box(rgb)) {
        return clamp(rgb, 0.0, 1.0);
    }
    vec3 lab = rec2020_to_oklab(rgb);
    float L = lab.x;
    vec2 ab = lab.yz;
    float lo = 0.0;
    float hi = 1.0;
    for (int i = 0; i < 24; ++i) {
        float mid = 0.5 * (lo + hi);
        vec3 candidate = oklab_to_rec2020(vec3(L, ab * mid));
        if (in_unit_box(candidate)) {
            lo = mid;
        } else {
            hi = mid;
        }
    }
    vec3 outc = oklab_to_rec2020(vec3(L, ab * lo));
    return clamp(outc, 0.0, 1.0);
}

// ── Jed Smith / Sobotka tunable sigmoid ──────────────────────────────────
// Pure inline port of \`equation_full_curve\` (AgX-S2O3 AgX.py L122-207).
// Splits into toe / shoulder branches around x_pivot. The scale equation
// requires SLOPE > (1 - Y_PIVOT) / (1 - X_PIVOT) ≈ 2.08 for a real
// solution; SLOPE = 2.4 sits above that threshold (see agx_coeffs.rs).
float agx_equation_scale(float x_pivot, float y_pivot, float slope, float power) {
    return pow(
        pow(slope * x_pivot, -power)
        * (pow(slope * (x_pivot / y_pivot), power) - 1.0),
        -1.0 / power
    );
}

float agx_sigmoid(float x) {
    x = clamp(x, 0.0, 1.0);
    float side_x, side_y, side_power, scale;
    if (x >= AGX_X_PIVOT) {
        // Shoulder
        side_x = 1.0 - AGX_X_PIVOT;
        side_y = 1.0 - AGX_Y_PIVOT;
        side_power = AGX_SHOULDER_POWER;
        scale = agx_equation_scale(side_x, side_y, AGX_SLOPE, side_power);
    } else {
        // Toe
        side_x = AGX_X_PIVOT;
        side_y = AGX_Y_PIVOT;
        side_power = AGX_TOE_POWER;
        scale = -agx_equation_scale(side_x, side_y, AGX_SLOPE, side_power);
    }
    float term = (AGX_SLOPE * (x - AGX_X_PIVOT)) / scale;
    float hyperbolic = term / pow(1.0 + pow(term, side_power), 1.0 / side_power);
    return clamp(scale * hyperbolic + AGX_Y_PIVOT, 0.0, 1.0);
}

// Apply contrast modulation: expand/compress around AGX_MID_NORM so
// contrast=0 → identity, +100 → steep sigmoid (spec § 3.6a). Pre-#435
// this clamped the modulated value to [0, 1] which posterised the toe
// and shoulder; \`agx_sigmoid\` already clamps its input so the inner
// clamp is redundant and harmful — removed in #435.
float apply_contrast(float t, float contrast) {
    if (abs(contrast) < 1e-3) return t;
    float s = 1.0 + contrast / 200.0;
    return (t - AGX_MID_NORM) * s + AGX_MID_NORM;
}

// Ratio-preserving sigmoid: sigmoid the max channel, scale RGB by the
// same factor. Hue invariant — replaces the per-channel form that
// produced magenta on saturated reds/blues/purples (#435).
vec3 agx_ratio_sigmoid(vec3 inset, float contrast) {
    float n = max(max(inset.r, inset.g), inset.b);
    if (n <= 1.0e-6) {
        float v = agx_sigmoid(apply_contrast(agx_log_encode(1.0e-6), contrast));
        return vec3(v);
    }
    float sn = agx_sigmoid(apply_contrast(agx_log_encode(n), contrast));
    float ratio = sn / n;
    return inset * ratio;
}

void main() {
    vec4 color = texture(uSrc, vTexCoord);
    vec3 p = color.rgb;

    // 1) Inset matrix: Rec.2020 → AgX-Base-Rec.2020. No pre-clamp:
    //    the ratio-preserving sigmoid below handles deep shadow without
    //    a luma gate (the old luma_coupled_toe is retired in #435).
    p = AGX_INSET * p;

    // 2) Ratio-preserving sigmoid (hue invariant).
    vec3 display = agx_ratio_sigmoid(p, uContrast);

    // 3) Outset matrix back to Rec.2020 primaries.
    display = AGX_OUTSET * display;

    // 4) Hue-preserving Oklab gamut compression to [0, 1]^3.
    display = oklab_gamut_compress(display);

    outColor = vec4(display, color.a);
}
`;
