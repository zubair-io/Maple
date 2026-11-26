//! Buffer endcaps for the per-tick chain: unpack the caller's packed RGBA
//! into the `Image { pixels: Vec<[f32; 3]> }` the stages operate on, and pack
//! the result back out. Split into this submodule to keep
//! `scene_linear_chain.rs` inside the file-size budget (#1089).
//!
//! Both pairs are parallel over pixels. The f32 pair was once kept serial as
//! memory-bound, but re-measured on a 4-core x86 box (#6018) the serial
//! `push` loops ran at 2–4 GB/s: at 2048x1365 pack took 22 ms serial against
//! 7 ms parallel, and unpack 4.9 ms against 0.8 ms.
//!
//! Every endcap here is a pure element-wise map with no reduction, and
//! rayon's indexed `par_chunks_exact` / `par_chunks_exact_mut` preserve
//! order, so the parallel forms are bit-identical to the serial loops they
//! replaced. `super::tests::chain_output_is_identical_across_thread_counts`
//! gates that.

use crate::image::{ColorSpace, Image};
use crate::pipeline::finite_or_zero;
use crate::pipeline::fp16::f16_bits_to_f32;
use half::slice::{HalfBitsSliceExt, HalfFloatSliceExt};
use rayon::prelude::*;

/// Pixels per batched fp16 conversion: a 16 KiB stack staging buffer.
const PACK_FP16_CHUNK: usize = 1024;

/// Decode packed fp16 RGBA into a scene-linear `Image`. Alpha is read but
/// discarded — every stage operates on straight RGB.
pub(super) fn unpack_fp16(in_fp16_rgba: &[u16], width: u32, height: u32) -> Image {
    let pixels: Vec<[f32; 3]> = in_fp16_rgba
        .par_chunks_exact(4)
        .map(|chunk| {
            [
                f16_bits_to_f32(chunk[0]),
                f16_bits_to_f32(chunk[1]),
                f16_bits_to_f32(chunk[2]),
            ]
        })
        .collect();
    Image {
        width,
        height,
        pixels,
        space: ColorSpace::SceneLinearRec2020,
        nr_sampling_scale: 1.0,
        whites_anchor_ev: None,
    }
}

/// Pack a scene-linear `Image` back to fp16 RGBA with alpha = 1.0.
///
/// `finite_or_zero` scrubs NaN/Inf here (#1088): `f32_to_f16_bits` preserves
/// NaN by design, and the caller hands these lanes straight to a GPU texture.
/// The conversion runs through `half`'s batched converter (F16C / NEON where
/// the CPU has it). It matches `f32_to_f16_bits` for every finite f32, which
/// `pack_fp16_matches_the_scalar_converter` pins on a sweep.
pub(super) fn pack_fp16(pixels: &[[f32; 3]]) -> Vec<u16> {
    let mut v: Vec<u16> = vec![0; pixels.len() * 4];
    v.par_chunks_mut(PACK_FP16_CHUNK * 4)
        .zip(pixels.par_chunks(PACK_FP16_CHUNK))
        .for_each(|(out, chunk)| {
            let mut lanes = [0.0f32; PACK_FP16_CHUNK * 4];
            for (lane, p) in lanes.chunks_exact_mut(4).zip(chunk) {
                lane[0] = finite_or_zero(p[0]);
                lane[1] = finite_or_zero(p[1]);
                lane[2] = finite_or_zero(p[2]);
                lane[3] = 1.0;
            }
            let halves: &mut [half::f16] = out.reinterpret_cast_mut();
            halves.convert_from_f32_slice(&lanes[..chunk.len() * 4]);
        });
    v
}

/// f32 sibling of [`unpack_fp16`]: a straight lane copy.
pub(super) fn unpack_f32(in_f32_rgba: &[f32], width: u32, height: u32) -> Image {
    let pixels: Vec<[f32; 3]> = in_f32_rgba
        .par_chunks_exact(4)
        .map(|chunk| [chunk[0], chunk[1], chunk[2]])
        .collect();
    Image {
        width,
        height,
        pixels,
        space: ColorSpace::SceneLinearRec2020,
        nr_sampling_scale: 1.0,
        whites_anchor_ev: None,
    }
}

/// f32 sibling of [`pack_fp16`]. Alpha is always 1.0; `finite_or_zero`
/// scrubs NaN/Inf at the endcap (#1088).
pub(super) fn pack_f32(pixels: &[[f32; 3]]) -> Vec<f32> {
    let mut v: Vec<f32> = vec![0.0; pixels.len() * 4];
    v.par_chunks_exact_mut(4)
        .zip(pixels.par_iter())
        .for_each(|(out, p)| {
            out[0] = finite_or_zero(p[0]);
            out[1] = finite_or_zero(p[1]);
            out[2] = finite_or_zero(p[2]);
            out[3] = 1.0;
        });
    v
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::pipeline::fp16::f32_to_f16_bits;

    #[test]
    fn pack_fp16_matches_the_scalar_converter() {
        let samples: Vec<f32> = (0u32..1 << 20)
            .map(|i| f32::from_bits(i.wrapping_mul(0x9E37_79B9)))
            .chain([
                f32::NAN,
                f32::INFINITY,
                -f32::INFINITY,
                65504.0,
                65520.0,
                6.0e-8,
                -0.0,
            ])
            .collect();
        let pixels: Vec<[f32; 3]> = samples
            .chunks(3)
            .map(|c| {
                [
                    c[0],
                    c.get(1).copied().unwrap_or(0.0),
                    c.get(2).copied().unwrap_or(0.0),
                ]
            })
            .collect();
        let expected: Vec<u16> = pixels
            .iter()
            .flat_map(|p| {
                [
                    f32_to_f16_bits(finite_or_zero(p[0])),
                    f32_to_f16_bits(finite_or_zero(p[1])),
                    f32_to_f16_bits(finite_or_zero(p[2])),
                    f32_to_f16_bits(1.0),
                ]
            })
            .collect();
        assert_eq!(pack_fp16(&pixels), expected);
    }
}
