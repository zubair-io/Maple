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

// ── Bayer 8×8 ordered-dither matrix (ticket #441) ────────────────────────
// Same matrix as raw-core's \`view/dither.rs::BAYER_8X8\`. Used to add
// ±0.5 LSB positional jitter to the canvas-bound output so smooth
// gradients don't band on the implicit RGBA8 quantize the browser does
// when this fragment is written to the canvas backbuffer.
//
// NOTE: the Rust side dithers in *gamma-encoded* sRGB u8 units, while
// this shader writes display-linear Rec.2020 to a wide-gamut RGBA8
// canvas — the browser handles the gamma+quantize step. Dither here
// is therefore *approximate parity* (same matrix, same indexing, same
// ±0.5 LSB amplitude, but applied in a different colour-encoding
// domain). Byte-identical parity would need an explicit gamma+quantize
// pass on the Web side; that's gated behind the f32 scene-buffer
// handoff in #482 and out of scope for #441.
//
// The matrix is unrolled into a 64-entry \`float\` array because GLSL
// ES 3.0 doesn't allow a const \`int[64]\` literal indexed by a non-const
// integer expression in all driver paths. Encoding as float saves the
// int→float cast inside the inner loop.
const float BAYER_8X8[64] = float[64](
     0.0, 32.0,  8.0, 40.0,  2.0, 34.0, 10.0, 42.0,
    48.0, 16.0, 56.0, 24.0, 50.0, 18.0, 58.0, 26.0,
    12.0, 44.0,  4.0, 36.0, 14.0, 46.0,  6.0, 38.0,
    60.0, 28.0, 52.0, 20.0, 62.0, 30.0, 54.0, 22.0,
     3.0, 35.0, 11.0, 43.0,  1.0, 33.0,  9.0, 41.0,
    51.0, 19.0, 59.0, 27.0, 49.0, 17.0, 57.0, 25.0,
    15.0, 47.0,  7.0, 39.0, 13.0, 45.0,  5.0, 37.0,
    63.0, 31.0, 55.0, 23.0, 61.0, 29.0, 53.0, 21.0
);

// Dither offset in \`[-0.5/255, +0.5/255)\` (i.e. ±0.5 LSB of the RGBA8
// canvas) for the current fragment. Indexed by \`gl_FragCoord.xy\` modulo
// 8 — matches the Rust \`bayer_offset_lsb(x, y)\` indexing.
float dither_offset_lsb() {
    int x = int(gl_FragCoord.x) & 7;
    int y = int(gl_FragCoord.y) & 7;
    float cell = BAYER_8X8[y * 8 + x];
    // Map 0..=63 to [-0.5, +0.5) — same closed-form as Rust:
    //   (cell + 0.5) / 64.0 - 0.5
    return (cell + 0.5) / 64.0 - 0.5;
}

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

    // 6) Ordered-dither the implicit RGBA8 canvas quantize (#441). Adds
    // a ±0.5 LSB positional offset so gradients pick up sub-LSB
    // variance instead of forming flat plateaus. Same offset on R/G/B
    // so neutrals stay neutral. Re-clamp because the +0.5/255 offset
    // would otherwise push the top of the display range over 1.0 and
    // the bottom under 0.0 before the implicit \`* 255 + 0.5 -> u8\`
    // happens at canvas write.
    float d = dither_offset_lsb() / 255.0;
    display = clamp(display + vec3(d), 0.0, 1.0);

    outColor = vec4(display, color.a);
}
`;
