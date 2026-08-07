// film_lut.wgsl — display-linear film-look 3D LUT (epic #2683, Task 7).
//
// Line-for-line WGSL port of `raw_core::stages::film_look::apply_pixel`
// (Task 6): a baked `.mlut` film-print lattice sampled by TETRAHEDRAL
// interpolation in the "encoded sRGB lattice" domain (the same domain a
// `.mlut` is built in), blended back into the display-linear Rec.2020
// working space by `strength`.
//
// Needs the generated color-matrix module (`mul_rec2020_to_srgb` /
// `mul_srgb_to_rec2020`, from `generated/color_matrices.wgsl`) prepended at
// compile time via `compile_with_matrices` — WGSL has no `#include`.
//
// PARITY-CRITICAL invariants (mirrored verbatim from `film_look::apply_pixel`
// / `film::tetra_sample`):
//   * Per-pixel chain: s_lin = mul_rec2020_to_srgb(original); enc =
//     clamp(srgb_gamma(s_lin), 0, 1); f_enc = tetra_sample(lut, enc); f_lin =
//     srgb_degamma(f_enc); f_2020 = mul_srgb_to_rec2020(f_lin); output =
//     mix(original, f_2020, t) where t = params.strength (ALREADY clamped
//     CPU-side to `clamp(strength/100, 0, 1)` — see `film_lut.rs::Params`).
//   * Grid layout: index = ((b*N + g)*N + r)*3 + c. `size` (N) is a runtime
//     uniform; last = f32(N - 1).
//   * Per-channel: p = clamp(rgb[c], 0, 1) * last; lo = min(floor(p), last - 1);
//     f = p - lo. The `min(_, last - 1)` is load-bearing: an input of exactly
//     1.0 lands in the TOP cell with f = 1.0 (not an out-of-range node read).
//   * Tetrahedral 6-case split on the ordering of fx/fy/fz — bit-stable
//     accumulation order matching the Rust `tetra_sample`.
//   * sRGB gamma encode clamps to [0, 1] FIRST (matching `srgb_gamma`'s
//     `x.clamp(0.0, 1.0)`); sRGB degamma has NO input clamp (matching
//     `srgb_degamma` — its input, a lattice sample, is already [0, 1]).
//   * RGB lanes only; alpha carried through.

struct Params {
    count: u32,    // number of RGBA pixels
    size: u32,     // LUT nodes per axis (N); grid is N*N*N*3 floats
    strength: f32, // ALREADY-CLAMPED blend t = clamp(strength/100, 0, 1)
    _pad: u32,
};

@group(0) @binding(0) var<uniform> params: Params;
@group(0) @binding(1) var<storage, read> input_buf: array<vec4<f32>>;
@group(0) @binding(2) var<storage, read_write> output_buf: array<vec4<f32>>;
// The baked film-print grid (N*N*N*3 f32, layout ((b*N+g)*N+r)*3+c).
// Read-only storage (4-byte stride) — a uniform array<f32> would get a
// 16-byte per-element stride and silently misalign.
@group(0) @binding(3) var<storage, read> film_lut: array<f32>;

// Single-channel piecewise sRGB gamma encode. Verbatim mirror of
// raw_core::view::gamma::srgb_gamma: clamp to [0, 1] FIRST, then the IEC
// piecewise OETF.
fn film_srgb_gamma(x: f32) -> f32 {
    let c = clamp(x, 0.0, 1.0);
    if (c <= 0.0031308) {
        return c * 12.92;
    }
    return 1.055 * pow(c, 1.0 / 2.4) - 0.055;
}

// Single-channel piecewise sRGB gamma decode. Verbatim mirror of
// raw_core::view::gamma::srgb_degamma: NO input clamp (the lattice sample it
// consumes is already [0, 1] by construction).
fn film_srgb_degamma(x: f32) -> f32 {
    if (x <= 0.04045) {
        return x / 12.92;
    }
    return pow((x + 0.055) / 1.055, 2.4);
}

// One grid node's RGB triplet. Mirrors `film::tetra_sample`'s `node`
// closure: manual flat index in u32, NO bounds clamp (the caller's `lo + 1`
// never exceeds N-1 because lo is capped at last-1).
fn film_lut_node(r: u32, g: u32, b: u32, n: u32) -> vec3<f32> {
    let i = ((b * n + g) * n + r) * 3u;
    return vec3<f32>(film_lut[i], film_lut[i + 1u], film_lut[i + 2u]);
}

// Tetrahedral lookup of one RGB triplet (inputs clamped to [0, 1]). Mirrors
// `raw_core::film::tetra_sample` EXACTLY — same lo/f derivation (with the
// `min(_, last-1)` top-cell guard) and the same 6-case barycentric split of
// the unit cube (by the ordering of f_r/f_g/f_b), blending only 4 of the 8
// corner nodes per sample. NOT trilinear (#1737).
fn film_lut_sample(rgb: vec3<f32>, n: u32) -> vec3<f32> {
    let last = f32(n - 1u);

    let p_r = clamp(rgb[0], 0.0, 1.0) * last;
    let l_r = min(floor(p_r), last - 1.0);
    let r0 = u32(l_r);
    let f_r = p_r - l_r;

    let p_g = clamp(rgb[1], 0.0, 1.0) * last;
    let l_g = min(floor(p_g), last - 1.0);
    let g0 = u32(l_g);
    let f_g = p_g - l_g;

    let p_b = clamp(rgb[2], 0.0, 1.0) * last;
    let l_b = min(floor(p_b), last - 1.0);
    let b0 = u32(l_b);
    let f_b = p_b - l_b;

    let r1 = r0 + 1u;
    let g1 = g0 + 1u;
    let b1 = b0 + 1u;

    let c000 = film_lut_node(r0, g0, b0, n);
    let c100 = film_lut_node(r1, g0, b0, n);
    let c010 = film_lut_node(r0, g1, b0, n);
    let c110 = film_lut_node(r1, g1, b0, n);
    let c001 = film_lut_node(r0, g0, b1, n);
    let c101 = film_lut_node(r1, g0, b1, n);
    let c011 = film_lut_node(r0, g1, b1, n);
    let c111 = film_lut_node(r1, g1, b1, n);

    var out = vec3<f32>(0.0, 0.0, 0.0);
    for (var c: i32 = 0; c < 3; c = c + 1) {
        if (f_r >= f_g) {
            if (f_g >= f_b) {
                out[c] = c000[c] * (1.0 - f_r) + c100[c] * (f_r - f_g) + c110[c] * (f_g - f_b) + c111[c] * f_b;
            } else if (f_r >= f_b) {
                out[c] = c000[c] * (1.0 - f_r) + c100[c] * (f_r - f_b) + c101[c] * (f_b - f_g) + c111[c] * f_g;
            } else {
                out[c] = c000[c] * (1.0 - f_b) + c001[c] * (f_b - f_r) + c101[c] * (f_r - f_g) + c111[c] * f_g;
            }
        } else {
            if (f_r >= f_b) {
                out[c] = c000[c] * (1.0 - f_g) + c010[c] * (f_g - f_r) + c110[c] * (f_r - f_b) + c111[c] * f_b;
            } else if (f_g >= f_b) {
                out[c] = c000[c] * (1.0 - f_g) + c010[c] * (f_g - f_b) + c011[c] * (f_b - f_r) + c111[c] * f_r;
            } else {
                out[c] = c000[c] * (1.0 - f_b) + c001[c] * (f_b - f_g) + c011[c] * (f_g - f_r) + c111[c] * f_r;
            }
        }
    }
    return out;
}

@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) gid: vec3<u32>, @builtin(num_workgroups) ng: vec3<u32>) {
    // 2-D dispatch index (#1881): see residual_lut.wgsl's identical comment —
    // `encode_simple` tiles big images into (gx <= 65535, gy) workgroup tiles.
    let i = gid.y * ng.x * 64u + gid.x;
    if (i >= params.count) {
        return;
    }
    let px = input_buf[i];
    let original = px.rgb;

    let s_lin = mul_rec2020_to_srgb(original);
    let enc = vec3<f32>(
        film_srgb_gamma(s_lin.x),
        film_srgb_gamma(s_lin.y),
        film_srgb_gamma(s_lin.z),
    );
    let f_enc = film_lut_sample(enc, params.size);
    let f_lin = vec3<f32>(
        film_srgb_degamma(f_enc.x),
        film_srgb_degamma(f_enc.y),
        film_srgb_degamma(f_enc.z),
    );
    let f_2020 = mul_srgb_to_rec2020(f_lin);

    let out = original + (f_2020 - original) * params.strength;
    output_buf[i] = vec4<f32>(out, px.a);
}
