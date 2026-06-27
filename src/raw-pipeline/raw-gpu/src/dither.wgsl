// dither.wgsl — the TERMINAL display-output encode (epic #925, P4b-core / #1027).
//
// Ports `raw_core::view::encode::dither_and_quantize`: the f32 → u8 quantize with
// an ordered (Bayer) ±0.5-LSB dither (ticket #441). This is the FORMAT-changing
// final stage of the live render path — the only kernel whose OUTPUT is not
// f32-RGBA (so it is a dedicated terminal encode, NOT a ping-pong chain `Pass`).
//
// Input is the chain's final sRGB-gamma-encoded f32-RGBA buffer in [0, 1] (the
// output of `srgb_gamma` → auto_profile_curve → residual_lut). Output is one u32
// per pixel packing the three RGB bytes in the low 24 bits (R = bits 0..7, G =
// 8..15, B = 16..23; alpha is dropped, matching raw-core's RGB-only `Vec<u8>` of
// length 3·w·h). The host unpacks that to the flat `3·w·h` u8 layout.
//
// PARITY-CRITICAL invariants (mirrored verbatim from the Rust stage):
//
// * (x, y) is recovered from the linear index EXACTLY as raw-core does:
//   `x = i % width`, `y = i / width` where `width` is the source-image stride
//   (`img.width`). The same offset is applied to ALL THREE channels at a pixel,
//   so a neutral input stays neutral after dithering (no chroma noise).
// * The Bayer offset is `(BAYER_8X8[y & 7][x & 7] + 0.5) / 64.0 - 0.5` — the
//   `bayer_offset_lsb` formula, mapping the cell value 0..=63 to [-0.5, +0.5).
//   The matrix below is the canonical 8×8 `B(8)`; a host-side test
//   (`dither.rs`) cross-checks it against `raw_core::view::dither::BAYER_8X8`
//   element-for-element so it can never drift.
// * The quantize is `(c * 255 + off + 0.5).clamp(0, 255) as u8`. raw-core's
//   `as u8` truncates toward zero; the value is clamped to [0, 255] and the +0.5
//   makes it round-half-up, so `u32(clamp(c*255 + off + 0.5, 0.0, 255.0))` (WGSL
//   `u32(f)` also truncates toward zero, on a non-negative clamped value) is
//   bit-identical.

struct Params {
    count: u32,  // number of RGBA pixels
    width: u32,  // source-image stride (img.width), for (x, y) recovery
    _pad0: u32,
    _pad1: u32,
};

@group(0) @binding(0) var<uniform> params: Params;
@group(0) @binding(1) var<storage, read> input_buf: array<vec4<f32>>;
// One u32 per pixel: RGB bytes packed in the low 24 bits (R | G<<8 | B<<16).
@group(0) @binding(2) var<storage, read_write> output_buf: array<u32>;

// The canonical 8×8 Bayer matrix `B(8)`, values 0..=63, row-major
// `BAYER_8X8[y][x]`. Flattened to 64 entries (`y*8 + x`). Identical to
// `raw_core::view::dither::BAYER_8X8` — pinned by `dither.rs`'s cross-check test.
const BAYER_8X8: array<u32, 64> = array<u32, 64>(
     0u, 32u,  8u, 40u,  2u, 34u, 10u, 42u,
    48u, 16u, 56u, 24u, 50u, 18u, 58u, 26u,
    12u, 44u,  4u, 36u, 14u, 46u,  6u, 38u,
    60u, 28u, 52u, 20u, 62u, 30u, 54u, 22u,
     3u, 35u, 11u, 43u,  1u, 33u,  9u, 41u,
    51u, 19u, 59u, 27u, 49u, 17u, 57u, 25u,
    15u, 47u,  7u, 39u, 13u, 45u,  5u, 37u,
    63u, 31u, 55u, 23u, 61u, 29u, 53u, 21u,
);

// Dither offset in LSB units ([-0.5, +0.5)) for pixel (x, y). Verbatim mirror of
// `raw_core::view::dither::bayer_offset_lsb`.
fn bayer_offset_lsb(x: u32, y: u32) -> f32 {
    let cell = BAYER_8X8[(y & 7u) * 8u + (x & 7u)];
    return (f32(cell) + 0.5) / 64.0 - 0.5;
}

// One channel's quantize: `(c*255 + off + 0.5).clamp(0, 255) as u8`. Returns the
// byte as a u32 in 0..=255.
fn quantize_channel(c: f32, off: f32) -> u32 {
    return u32(clamp(c * 255.0 + off + 0.5, 0.0, 255.0));
}

@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) gid: vec3<u32>, @builtin(num_workgroups) ng: vec3<u32>) {
    let i = gid.y * ng.x * 64u + gid.x;
    if (i >= params.count) {
        return;
    }
    // Recover (x, y) from the linear index — same stride/layout as raw-core.
    let x = i % params.width;
    let y = i / params.width;
    let off = bayer_offset_lsb(x, y);

    let px = input_buf[i];
    let r = quantize_channel(px.r, off);
    let g = quantize_channel(px.g, off);
    let b = quantize_channel(px.b, off);

    // Pack RGB into the low 24 bits; alpha dropped (raw-core outputs RGB only).
    output_buf[i] = r | (g << 8u) | (b << 16u);
}
