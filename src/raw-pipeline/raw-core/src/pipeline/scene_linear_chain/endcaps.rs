//! Buffer endcaps for the per-tick chain: unpack the caller's packed RGBA
//! into the `Image { pixels: Vec<[f32; 3]> }` the stages operate on, and pack
//! the result back out. Split into this submodule to keep
//! `scene_linear_chain.rs` inside the file-size budget (#1089).
//!
//! The fp16 pair is parallel over pixels and the f32 pair is not, which is a
//! deliberate asymmetry rather than an oversight. `f32_to_f16_bits` /
//! `f16_bits_to_f32` are scalar software converters carrying
//! round-to-nearest-even and subnormal arms, so the fp16 endcaps are
//! compute-bound: measured at 1728x1152 the fp16 pack moved 40 MB in ~31 ms
//! (~1.0 GB/s) against a ~115 GB/s single-thread DRAM ceiling. The f32
//! endcaps do no conversion at all — they are straight lane copies that
//! already run at ~9 GB/s on a larger 56 MB working set, i.e. memory-bound,
//! which is the shape #1089's NLM item proved does not benefit from threading.
//! Do not "fix" the asymmetry without re-measuring.
//!
//! Every endcap here is a pure element-wise map with no reduction, and
//! rayon's indexed `par_chunks_exact` / `par_chunks_exact_mut` preserve
//! order, so the parallel forms are bit-identical to the serial loops they
//! replaced. `super::tests::chain_output_is_identical_across_thread_counts`
//! gates that.

use crate::image::{ColorSpace, Image};
use crate::pipeline::finite_or_zero;
use crate::pipeline::fp16::{f16_bits_to_f32, f32_to_f16_bits};
use rayon::prelude::*;

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
    }
}

/// Pack a scene-linear `Image` back to fp16 RGBA with alpha = 1.0.
///
/// `finite_or_zero` scrubs NaN/Inf here (#1088): `f32_to_f16_bits` preserves
/// NaN by design, and the caller hands these lanes straight to a GPU texture.
pub(super) fn pack_fp16(pixels: &[[f32; 3]]) -> Vec<u16> {
    let alpha_one = f32_to_f16_bits(1.0);
    let mut v: Vec<u16> = vec![0; pixels.len() * 4];
    v.par_chunks_exact_mut(4)
        .zip(pixels.par_iter())
        .for_each(|(out, p)| {
            out[0] = f32_to_f16_bits(finite_or_zero(p[0]));
            out[1] = f32_to_f16_bits(finite_or_zero(p[1]));
            out[2] = f32_to_f16_bits(finite_or_zero(p[2]));
            out[3] = alpha_one;
        });
    v
}

/// f32 sibling of [`unpack_fp16`]. Straight lane copy — see the module note
/// on why this one stays serial.
pub(super) fn unpack_f32(in_f32_rgba: &[f32], width: u32, height: u32) -> Image {
    let pixel_count = (width as usize) * (height as usize);
    let mut pixels: Vec<[f32; 3]> = Vec::with_capacity(pixel_count);
    for chunk in in_f32_rgba.chunks_exact(4) {
        pixels.push([chunk[0], chunk[1], chunk[2]]);
    }
    Image {
        width,
        height,
        pixels,
        space: ColorSpace::SceneLinearRec2020,
    }
}

/// f32 sibling of [`pack_fp16`]. Alpha is always 1.0; `finite_or_zero`
/// scrubs NaN/Inf at the endcap (#1088).
pub(super) fn pack_f32(pixels: &[[f32; 3]]) -> Vec<f32> {
    let mut v: Vec<f32> = Vec::with_capacity(pixels.len() * 4);
    for p in pixels {
        v.push(finite_or_zero(p[0]));
        v.push(finite_or_zero(p[1]));
        v.push(finite_or_zero(p[2]));
        v.push(1.0);
    }
    v
}
