//! Dither + quantize — the TERMINAL display-output encode (epic #925, P4b-core /
//! #1027). Ports `raw_core::view::encode::dither_and_quantize`: f32 → u8 with an
//! ordered (Bayer) ±0.5-LSB dither (ticket #441).
//!
//! Unlike every other GPU stage this one CHANGES THE OUTPUT TYPE — f32-RGBA in,
//! packed-u8-RGB out — so it is NOT a ping-pong chain [`crate::Pass`] (whose
//! `encode` threads f32 `src` → f32 `dst`). It is a dedicated terminal encode:
//! the live session ([`crate::LiveSession`], C3) runs the f32 chain to its final
//! buffer, then calls [`encode_dither`] to produce the u8 surface bytes.
//!
//! Three pieces (the per-stage template, adapted for a terminal):
//! 1. [`dither_and_quantize`] — the CPU oracle: a faithful port of raw-core's
//!    `dither_and_quantize` (Bayer LSB dither, `(c*255 + off + 0.5).clamp(0,255)
//!    as u8`), producing the flat `3·w·h` u8 RGB buffer.
//! 2. [`encode_dither`] — records the GPU dispatch (`dither.wgsl`): f32-RGBA `src`
//!    → a `count`-u32 `dst` packing RGB in the low 24 bits. [`unpack_rgb_u8`]
//!    turns that into the same `3·w·h` u8 layout the oracle emits.
//! 3. The byte-parity test (`dither/tests.rs`) — GPU vs raw-core's
//!    `dither_and_quantize`, byte-exact over a structured f32 buffer spanning
//!    `[0, 1]` + the knee + the round-half boundary + out-of-range clamp ends.

use crate::context::GpuContext;

/// The flattened canonical 8×8 Bayer matrix (`B(8)`, `y*8 + x`), inlined here for
/// the CPU oracle. Pinned to `raw_core::view::dither::BAYER_8X8` by the test
/// [`tests::inlined_bayer_matches_raw_core`] so it can never drift; the WGSL
/// kernel inlines the same 64 values.
const BAYER_8X8_FLAT: [u32; 64] = [
    0, 32, 8, 40, 2, 34, 10, 42, //
    48, 16, 56, 24, 50, 18, 58, 26, //
    12, 44, 4, 36, 14, 46, 6, 38, //
    60, 28, 52, 20, 62, 30, 54, 22, //
    3, 35, 11, 43, 1, 33, 9, 41, //
    51, 19, 59, 27, 49, 17, 57, 25, //
    15, 47, 7, 39, 13, 45, 5, 37, //
    63, 31, 55, 23, 61, 29, 53, 21, //
];

/// Dither offset in LSB units (`[-0.5, +0.5)`) for pixel `(x, y)` — verbatim
/// `raw_core::view::dither::bayer_offset_lsb`.
#[inline]
fn bayer_offset_lsb(x: u32, y: u32) -> f32 {
    let cell = BAYER_8X8_FLAT[((y as usize) & 7) * 8 + ((x as usize) & 7)];
    (cell as f32 + 0.5) / 64.0 - 0.5
}

/// The CPU oracle: dither + quantize an interleaved RGBA f32 buffer (already
/// sRGB-gamma-encoded, in `[0, 1]`) to a flat row-major `3·w·h` u8 RGB buffer.
/// A faithful port of `raw_core::view::encode::dither_and_quantize`: per pixel,
/// recover `(x, y)` from the linear index (`x = i % width`, `y = i / width`),
/// add the Bayer offset to all three channels, `(c*255 + off + 0.5).clamp(0,255)
/// as u8`. `width × height` must equal `buf.len() / 4`.
pub fn dither_and_quantize(buf: &[f32], width: usize, height: usize) -> Vec<u8> {
    assert_eq!(
        buf.len(),
        width * height * 4,
        "dither oracle: buffer/dims mismatch"
    );
    let mut out = vec![0u8; width * height * 3];
    for i in 0..(width * height) {
        let x = (i % width) as u32;
        let y = (i / width) as u32;
        let off = bayer_offset_lsb(x, y);
        for j in 0..3 {
            let c = buf[i * 4 + j];
            out[i * 3 + j] = (c * 255.0 + off + 0.5).clamp(0.0, 255.0) as u8;
        }
    }
    out
}

/// `repr(C)` uniform for `dither.wgsl`: the RGBA pixel count + the source-image
/// stride (`width`, for the `(x, y)` recovery). `_pad*` round to 16 bytes.
#[repr(C)]
#[derive(Clone, Copy, bytemuck::Pod, bytemuck::Zeroable)]
struct Params {
    count: u32,
    width: u32,
    _pad0: u32,
    _pad1: u32,
}

/// Allocate the packed-u8 output buffer for an `width × height` image: one u32
/// per pixel (RGB in the low 24 bits). `STORAGE | COPY_SRC` so the dither kernel
/// writes it and the session reads it back. The byte length is `4 · w · h`.
pub fn alloc_packed_rgb(ctx: &GpuContext, width: u32, height: u32, label: &str) -> wgpu::Buffer {
    ctx.device.create_buffer(&wgpu::BufferDescriptor {
        label: Some(label),
        size: (width as u64) * (height as u64) * std::mem::size_of::<u32>() as u64,
        usage: wgpu::BufferUsages::STORAGE | wgpu::BufferUsages::COPY_SRC,
        mapped_at_creation: false,
    })
}

/// Record the terminal dither+quantize dispatch: read the f32-RGBA `src` (the
/// chain's final sRGB-gamma-encoded buffer in `[0, 1]`), write one packed-u32 RGB
/// value per pixel into `dst` (from [`alloc_packed_rgb`]). One dispatch of
/// `count.div_ceil(64)` workgroups of the cached dither pipeline.
///
/// `dst` is NOT an f32 ping-pong buffer — this is the format-changing terminal,
/// so it lives outside the chain's two scratch buffers (the session owns it).
pub fn encode_dither(
    ctx: &GpuContext,
    encoder: &mut wgpu::CommandEncoder,
    src: &wgpu::Buffer,
    dst: &wgpu::Buffer,
    dims: (u32, u32),
) {
    let (width, height) = dims;
    let count = width * height;
    let params = Params {
        count,
        width,
        _pad0: 0,
        _pad1: 0,
    };
    // Pool-routed like every other dispatch (P4b-core C3): params @0, f32-in @1,
    // packed-u8-out @2. Inside a live render window the uniform + bind group are
    // cached (zero alloc on a same-signature re-render); outside one (the dither
    // unit test) the pool is dormant and this falls back to a plain create.
    crate::spatial::encode_simple(
        ctx,
        encoder,
        ctx.dither_pipeline(),
        bytemuck::bytes_of(&params),
        &[src, dst],
        count,
        "dither",
    );
}

/// Unpack the dither kernel's `count`-u32 output (RGB in the low 24 bits) into
/// the flat row-major `3·count` u8 RGB layout `dither_and_quantize` emits. The
/// inverse of `dither.wgsl`'s `r | g<<8 | b<<16` pack.
pub fn unpack_rgb_u8(packed: &[u32]) -> Vec<u8> {
    let mut out = vec![0u8; packed.len() * 3];
    for (i, &p) in packed.iter().enumerate() {
        out[i * 3] = (p & 0xFF) as u8;
        out[i * 3 + 1] = ((p >> 8) & 0xFF) as u8;
        out[i * 3 + 2] = ((p >> 16) & 0xFF) as u8;
    }
    out
}

// Byte-parity tests live in a sibling file to keep this module under the 600-LOC
// budget (mirrors the other stage tests.rs splits). Native test builds only.
#[cfg(all(test, not(target_arch = "wasm32")))]
#[path = "dither/tests.rs"]
mod tests;
