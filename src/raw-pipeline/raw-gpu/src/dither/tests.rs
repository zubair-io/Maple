//! Byte-parity for the TERMINAL dither+quantize encode (epic #925, P4b-core /
//! #1027): the WGSL `dither.wgsl` kernel vs `raw_core::view::encode::
//! dither_and_quantize` — the REAL Rust stage (via the test-only raw-core
//! dev-dep) — BYTE-EXACT.
//!
//! Split out of `dither.rs` for the 600-LOC budget. The fixture deliberately
//! spans the cases a smooth ramp would miss (the advisor's C2 hint — a ramp can
//! pass a broken port):
//!   - values straddling the round-half boundary (`c*255` near an integer + 0.5),
//!     where the Bayer offset flips which byte the round lands on,
//!   - the clamp ends: exactly 0.0, exactly 1.0, and OUT-OF-RANGE (< 0, > 1),
//!   - the full 8×8 Bayer tile in BOTH x and y (so every matrix cell is used),
//!   - a neutral grey column (all three channels equal → the same offset keeps
//!     the output neutral, no chroma noise).

use super::*;
use crate::context::GpuContext;
use crate::image::GpuImage;

use raw_core::image::{ColorSpace, Image};

/// A structured 8×8 sRGB-gamma-encoded f32-RGBA fixture (so the Bayer tile is
/// fully exercised in x and y). Each pixel's channels are chosen to hit the
/// parity-critical cases:
///   - a base ramp across `[0, 1]`,
///   - several values landing near `k/255` and `(k+0.5)/255` (the round-half
///     boundary the dither offset perturbs),
///   - explicit 0.0 / 1.0 / out-of-range (< 0, > 1) seeds,
///   - a neutral grey diagonal (r == g == b).
fn dither_fixture(w: usize, h: usize) -> Vec<f32> {
    let mut v = Vec::with_capacity(w * h * 4);
    for y in 0..h {
        for x in 0..w {
            let i = y * w + x;
            let t = i as f32 / (w * h) as f32; // 0..1 ramp
                                               // A few channels deliberately near a u8 round-half boundary: pick a
                                               // target byte `k` and set c so `c*255` ≈ k + 0.5 (the dither offset
                                               // then tips it up or down depending on the Bayer cell).
            let k = (i % 256) as f32;
            let near_half = (k + 0.5) / 255.0;

            let (mut r, mut g, mut b) = (0.05 + t * 0.9, near_half, 0.5 - t * 0.4);

            // Seed the clamp + edge cases at known positions so they're always
            // present regardless of dims.
            match i % 13 {
                0 => {
                    r = 0.0;
                    g = 0.0;
                    b = 0.0;
                } // pure black (byte 0)
                1 => {
                    r = 1.0;
                    g = 1.0;
                    b = 1.0;
                } // pure white (byte 255)
                2 => {
                    r = -0.10;
                    g = -0.50;
                    b = -0.01;
                } // below range → clamp to 0
                3 => {
                    r = 1.20;
                    g = 2.00;
                    b = 1.01;
                } // above range → clamp to 255
                4 => {
                    // neutral grey (all equal): the same offset must keep it neutral.
                    let n = 0.18 + 0.3 * t;
                    r = n;
                    g = n;
                    b = n;
                }
                _ => {}
            }
            v.extend_from_slice(&[r, g, b, 1.0]);
        }
    }
    v
}

/// Run `raw_core::view::encode::dither_and_quantize` on a flat interleaved
/// sRGB-gamma-encoded RGBA f32 buffer, returning the flat `3·w·h` u8 RGB buffer.
/// The input space is `DisplayEncodedSrgb` (what the stage asserts). THE ticket's
/// reference — the Rust stage itself.
fn raw_core_dither(buf: &[f32], w: usize, h: usize) -> Vec<u8> {
    let mut img = Image::new(w as u32, h as u32, ColorSpace::DisplayEncodedSrgb);
    for (i, chunk) in buf.chunks_exact(4).enumerate() {
        img.pixels[i] = [chunk[0], chunk[1], chunk[2]];
    }
    raw_core::view::encode::dither_and_quantize(&mut img)
}

/// Run the GPU dither kernel over `input` (f32-RGBA) and return the unpacked
/// `3·w·h` u8 RGB buffer. dither is a TERMINAL encode (not a chain `Pass`), so
/// this drives it directly: upload `input` as the read-only src storage buffer,
/// alloc the packed-u32 dst, encode one dispatch, read back, unpack.
fn run_gpu_dither(ctx: &GpuContext, input: &[f32], w: u32, h: u32) -> Vec<u8> {
    // `GpuImage`'s buffer is `STORAGE | COPY_SRC | COPY_DST` and immutable here —
    // dither only reads it, so it's a fine src for the terminal encode.
    let img = GpuImage::upload(ctx, input, w, h);
    let dst = alloc_packed_rgb(ctx, w, h, "dither-test-dst");

    let mut encoder = ctx
        .device
        .create_command_encoder(&wgpu::CommandEncoderDescriptor {
            label: Some("dither-test-encoder"),
        });
    encode_dither(ctx, &mut encoder, &img.buffer, &dst, (w, h));

    // Read the packed-u32 dst back. (Tests only — the live session reads back
    // once at end-of-run; this mirrors that for the parity gate.)
    let count = (w * h) as u64;
    let byte_len = count * std::mem::size_of::<u32>() as u64;
    let readback = ctx.device.create_buffer(&wgpu::BufferDescriptor {
        label: Some("dither-test-readback"),
        size: byte_len,
        usage: wgpu::BufferUsages::COPY_DST | wgpu::BufferUsages::MAP_READ,
        mapped_at_creation: false,
    });
    encoder.copy_buffer_to_buffer(&dst, 0, &readback, 0, byte_len);
    ctx.queue.submit(Some(encoder.finish()));

    let slice = readback.slice(..);
    let (tx, rx) = futures_channel::oneshot::channel();
    slice.map_async(wgpu::MapMode::Read, move |res| {
        let _ = tx.send(res);
    });
    ctx.device.poll(wgpu::Maintain::Wait);
    pollster::block_on(rx)
        .expect("map channel dropped")
        .expect("buffer map failed");
    let data = slice.get_mapped_range();
    let packed: Vec<u32> = bytemuck::cast_slice(&data).to_vec();
    drop(data);
    readback.unmap();

    unpack_rgb_u8(&packed)
}

/// The inlined blue noise matrix (CPU oracle + WGSL) must equal
/// `raw_core::view::dither::BLUE_NOISE_64X64` element-for-element — so neither copy can
/// drift from the canonical golden matrix.
#[test]
fn inlined_blue_noise_matches_raw_core() {
    for i in 0..4096 {
        let mine = BLUE_NOISE_64X64[i];
        let theirs = raw_core::view::dither::BLUE_NOISE_64X64[i];
        assert_eq!(
            mine, theirs,
            "Blue noise cell {i} drifted: inlined {mine} != raw-core {theirs}"
        );
    }
}

/// THE PARITY GATE (the ticket's contract): the WGSL dither kernel matches
/// `raw_core::view::encode::dither_and_quantize` — the actual Rust stage, via the
/// test-only raw-core dev-dep — BYTE-EXACT, over the structured fixture (round-
/// half boundary, clamp ends, the full blue noise tile, a neutral column).
#[test]
fn wgsl_dither_matches_raw_core_byte_exact() {
    let ctx = GpuContext::new_blocking().expect("gpu context");
    let (w, h) = (64u32, 64u32);
    let input = dither_fixture(w as usize, h as usize);

    let reference = raw_core_dither(&input, w as usize, h as usize);
    let gpu = run_gpu_dither(&ctx, &input, w, h);

    assert_eq!(reference.len(), gpu.len(), "output length mismatch");
    // Byte-exact: find the first mismatch (if any) for a legible failure.
    let mut mismatches = 0usize;
    let mut first: Option<(usize, u8, u8)> = None;
    for (i, (&r, &g)) in reference.iter().zip(&gpu).enumerate() {
        if r != g {
            mismatches += 1;
            if first.is_none() {
                first = Some((i, r, g));
            }
        }
    }
    eprintln!(
        "DITHER PARITY: {mismatches} / {} bytes differ (byte-exact gate)",
        reference.len()
    );
    assert_eq!(
        mismatches, 0,
        "GPU dither vs raw-core dither_and_quantize: {mismatches} byte mismatches; \
         first at byte {first:?} (index, raw-core, gpu)"
    );
}

/// Pin the local CPU oracle to raw-core's stage too, so the convenience oracle
/// this crate exports (`dither_and_quantize`) can't silently drift. (The GPU gate
/// above doesn't depend on the local oracle.)
#[test]
fn local_oracle_matches_raw_core_byte_exact() {
    let (w, h) = (8usize, 8usize);
    let input = dither_fixture(w, h);
    let reference = raw_core_dither(&input, w, h);
    let local = dither_and_quantize(&input, w, h);
    assert_eq!(
        reference, local,
        "local dither oracle drifted from raw-core dither_and_quantize"
    );
}

/// A neutral grey input must stay neutral after dithering (the same Bayer offset
/// is added to all three channels, so r == g == b in → r == g == b out — no
/// chroma noise). Mirrors raw-core's "neutral input stays neutral" invariant.
#[test]
fn neutral_input_stays_neutral_on_gpu() {
    let ctx = GpuContext::new_blocking().expect("gpu context");
    let (w, h) = (8u32, 8u32);
    // Every pixel a (different) neutral grey across the range.
    let mut input = Vec::with_capacity((w * h * 4) as usize);
    for i in 0..(w * h) as usize {
        let n = i as f32 / (w * h) as f32;
        input.extend_from_slice(&[n, n, n, 1.0]);
    }
    let gpu = run_gpu_dither(&ctx, &input, w, h);
    for px in gpu.chunks_exact(3) {
        assert_eq!(
            px[0], px[1],
            "neutral grey gained chroma on the GPU: {px:?}"
        );
        assert_eq!(
            px[1], px[2],
            "neutral grey gained chroma on the GPU: {px:?}"
        );
    }
}
