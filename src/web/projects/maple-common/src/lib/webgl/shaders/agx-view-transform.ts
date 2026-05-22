// agx-view-transform.ts — Maple AgX GLSL fragment shader.
// Canonical Sobotka AgX (#263): inset matrix → log encode →
// per-channel Jed Smith sigmoid → outset matrix → clamp.
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

// ── Rec.2020 luminance weights (BT.2020) ─────────────────────────────────
const vec3 REC2020_LUM = vec3(0.2627, 0.6780, 0.0593);

// Luminance-coupled toe floor: replaces the old per-channel \`max(scene,
// floor)\` clamp that asymmetrically clipped channels in deep shadows.
// Pixels whose luminance is itself below the AgX toe pin uniformly to
// the floor; in-gamut shadow pixels pass through.
vec3 luma_coupled_toe(vec3 pixel) {
    float floor_v = AGX_MID_GRAY * exp2(AGX_MIN_EV);
    float y = dot(pixel, REC2020_LUM);
    if (y >= floor_v) {
        return pixel;
    }
    return vec3(floor_v);
}

// Per-channel log2-encode + normalize to [0, 1].
float agx_log_encode(float linear) {
    float floor_v = AGX_MID_GRAY * exp2(AGX_MIN_EV);
    float clamped = max(linear, floor_v);
    float log_v = clamp(log2(clamped / AGX_MID_GRAY), AGX_MIN_EV, AGX_MAX_EV);
    return (log_v - AGX_MIN_EV) / (AGX_MAX_EV - AGX_MIN_EV);
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

// Apply contrast modulation: expand/compress around AGX_MID_NORM
// so contrast=0 → identity, +100 → steep sigmoid (spec § 3.6a).
float apply_contrast(float t, float contrast) {
    if (abs(contrast) < 1e-3) return t;
    float s = 1.0 + contrast / 200.0;
    float shifted = (t - AGX_MID_NORM) * s + AGX_MID_NORM;
    return clamp(shifted, 0.0, 1.0);
}

void main() {
    vec4 color = texture(uSrc, vTexCoord);
    vec3 p = color.rgb;

    // 1) Luminance-coupled toe floor.
    p = luma_coupled_toe(p);

    // 2) Inset matrix: Rec.2020 → AgX-Base-Rec.2020.
    p = AGX_INSET * p;

    // 3) Per-channel log encode.
    vec3 log_encoded = vec3(
        agx_log_encode(p.r),
        agx_log_encode(p.g),
        agx_log_encode(p.b)
    );

    // 4) Contrast modulation, then sigmoid per channel.
    log_encoded = vec3(
        apply_contrast(log_encoded.r, uContrast),
        apply_contrast(log_encoded.g, uContrast),
        apply_contrast(log_encoded.b, uContrast)
    );

    vec3 display = vec3(
        agx_sigmoid(log_encoded.r),
        agx_sigmoid(log_encoded.g),
        agx_sigmoid(log_encoded.b)
    );

    // 5) Outset matrix back to Rec.2020 primaries; clamp to display range.
    display = AGX_OUTSET * display;
    display = clamp(display, 0.0, 1.0);

    outColor = vec4(display, color.a);
}
`;
