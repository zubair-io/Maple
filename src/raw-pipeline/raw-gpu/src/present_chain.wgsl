// present_chain.wgsl — CHAIN-OUTPUT present (epic #925 / P4b-apple #1028,
// P4b-web #1029).
//
// The colour-correct sibling of `present.wgsl` (P1b's passthrough test pattern).
// A fullscreen triangle (3 vertices from @builtin(vertex_index), no vertex
// buffer) whose fragment shader SAMPLES the live chain's final f32-RGBA buffer
// (the output of `LiveSession::render_chain_to_f32` — sRGB-gamma-encoded
// sRGB-primary in [0, 1]) as a read-only storage buffer, applies the EXACT
// `dither_and_quantize` math, and writes the result to the display surface.
//
// ## Why this runs the dither in the fragment shader (not the compute kernel)
//
// `dither.wgsl` is the headless terminal: f32 → a packed-u32 STORAGE buffer the
// host reads back. The present path has no readback — it writes a surface
// texture — so the quantize is folded into the FS here. The 8-bit surface
// (`Bgra8Unorm`, NON-sRGB — see `pick_surface_format`) performs the float→u8
// conversion on store as `round(c * 255)`. To reproduce `dither_and_quantize`'s
// `(c*255 + off + 0.5).clamp(0,255) as u8` (an `as u8` TRUNCATION of a non-
// negative clamped value = round-half-up), the FS emits
//   `floor(clamp(c*255 + off + 0.5, 0, 255)) / 255.0`
// so the surface's own round-to-nearest maps the already-integral value back to
// the SAME byte. Any residual is ≤ 1 LSB (the float-eval ordering the plan
// sanctions); the host-side parity test (`present/tests.rs`) measures it.
//
// PARITY-CRITICAL invariants (mirrored verbatim from `dither.wgsl`):
//
// * (x, y) is recovered from the FRAGMENT POSITION, which wgpu defines in
//   framebuffer space with origin top-left and y increasing DOWNWARD — exactly
//   the row-major top-down layout the chain's f32 buffer uses (`i = y*width + x`,
//   `x = i % width`, `y = i / width`). The present surface dims are PINNED equal
//   to the image dims on the Rust side (`present_chain` asserts it), so
//   `px = u32(pos.x)`, `py = u32(pos.y)` index the f32 buffer 1:1 and the Bayer
//   cell lands on the same pixel as the headless dither.
// * The same Bayer offset is added to ALL THREE channels at a pixel (neutral
//   stays neutral). The matrix is the canonical 8×8 `B(8)`, identical to
//   `raw_core::view::dither::BAYER_8X8` (pinned by `dither.rs`'s cross-check).
// * Alpha is forced to 1.0 — the chain's f32 alpha is unused on a display
//   surface; an opaque write matches the layer's `isOpaque`/framebuffer-only
//   configuration.

struct Params {
    width: u32,   // source-image stride (= surface width), for (x, y) recovery
    height: u32,  // surface height (bounds guard)
    _pad0: u32,
    _pad1: u32,
};

@group(0) @binding(0) var<uniform> params: Params;
// The chain's final f32-RGBA buffer (sRGB-gamma-encoded, [0, 1]), row-major.
@group(0) @binding(1) var<storage, read> chain_buf: array<vec4<f32>>;

// The canonical 8×8 Bayer matrix `B(8)`, values 0..=63, row-major
// `BAYER_8X8[y][x]`. Flattened to 64 entries (`y*8 + x`). Identical to
// `raw_core::view::dither::BAYER_8X8` (and `dither.wgsl`) — pinned by the
// `dither.rs` cross-check so it can never drift.
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
// `raw_core::view::dither::bayer_offset_lsb` / `dither.wgsl`.
fn bayer_offset_lsb(x: u32, y: u32) -> f32 {
    let cell = BAYER_8X8[(y & 7u) * 8u + (x & 7u)];
    return (f32(cell) + 0.5) / 64.0 - 0.5;
}

// One channel's dither+quantize, mapped back to [0, 1] for the unorm surface.
// `floor(clamp(c*255 + off + 0.5, 0, 255))` is the SAME integer byte
// `dither_and_quantize` produces (`as u8` truncation of a non-negative clamped
// value); dividing by 255 yields the canonical unorm value the surface's
// round-to-nearest store reproduces exactly.
fn quantized_channel(c: f32, off: f32) -> f32 {
    return floor(clamp(c * 255.0 + off + 0.5, 0.0, 255.0)) / 255.0;
}

struct VsOut {
    @builtin(position) pos: vec4<f32>,
};

@vertex
fn vs_main(@builtin(vertex_index) vid: u32) -> VsOut {
    // Oversized triangle covering the whole clip volume (same construction as
    // `present.wgsl`). No UVs needed — the FS reads its pixel from the integral
    // framebuffer position, not an interpolated coordinate.
    var out: VsOut;
    let x = f32((vid << 1u) & 2u); // 0, 2, 0
    let y = f32(vid & 2u);         // 0, 0, 2
    out.pos = vec4<f32>(x * 2.0 - 1.0, y * 2.0 - 1.0, 0.0, 1.0);
    return out;
}

@fragment
fn fs_main(in: VsOut) -> @location(0) vec4<f32> {
    // Framebuffer-space pixel (top-left origin, y down) → the row-major f32 index.
    let px = u32(in.pos.x);
    let py = u32(in.pos.y);
    // Defensive bounds guard (the fullscreen triangle only covers the configured
    // surface, so this never trips in practice, but a clamp avoids any OOB read
    // if the rasterizer ever emits an edge fragment one texel past the surface).
    if (px >= params.width || py >= params.height) {
        return vec4<f32>(0.0, 0.0, 0.0, 1.0);
    }
    let i = py * params.width + px;
    let off = bayer_offset_lsb(px, py);
    let c = chain_buf[i];
    return vec4<f32>(
        quantized_channel(c.r, off),
        quantized_channel(c.g, off),
        quantized_channel(c.b, off),
        1.0,
    );
}
