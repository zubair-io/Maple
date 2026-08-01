use crate::error::Result;
use crate::image::{ColorSpace, Image};
use crate::pipeline::fp16::{f16_bits_to_f32, f32_to_f16_bits};
use rayon::prelude::*;

/// Composite synthetic-raw `patches` into an f32 RGBA scene-linear buffer at the
/// pre-user-grade seam, returning a new f32 RGBA buffer (alpha = 1.0).
pub fn composite_into_f32(
    in_f32_rgba: &[f32],
    width: u32,
    height: u32,
    patches: &[crate::types::InpaintPatch],
) -> Result<Vec<f32>> {
    let pixel_count = (width as usize)
        .checked_mul(height as usize)
        .ok_or_else(|| {
            crate::error::Error::Pipeline(format!(
                "composite_into_f32: pixel count overflow: {width}x{height}"
            ))
        })?;
    let expected_len = pixel_count.checked_mul(4).ok_or_else(|| {
        crate::error::Error::Pipeline(format!(
            "composite_into_f32: expected length overflow: {width}x{height}"
        ))
    })?;
    if in_f32_rgba.len() != expected_len {
        return Err(crate::error::Error::Pipeline(format!(
            "composite_into_f32: input length {} != {width}*{height}*4 = {expected_len}",
            in_f32_rgba.len()
        )));
    }
    let mut img = Image {
        width,
        height,
        pixels: in_f32_rgba
            .chunks_exact(4)
            .map(|c| [c[0], c[1], c[2]])
            .collect(),
        space: ColorSpace::SceneLinearRec2020,
    };
    crate::stages::inpaint_composite::apply(&mut img, patches);
    let mut out = Vec::with_capacity(expected_len);
    for p in &img.pixels {
        out.extend_from_slice(&[p[0], p[1], p[2], 1.0]);
    }
    Ok(out)
}

/// fp16 sibling of [`composite_into_f32`]. fp16 unpack→pack is lossless for
/// already-fp16 data, so sensor pixels are untouched; only the patch is
/// fp16-quantized (it is fp16 on disk anyway).
pub fn composite_into_fp16(
    in_fp16_rgba: &[u16],
    width: u32,
    height: u32,
    patches: &[crate::types::InpaintPatch],
) -> Result<Vec<u16>> {
    let pixel_count = (width as usize)
        .checked_mul(height as usize)
        .ok_or_else(|| {
            crate::error::Error::Pipeline(format!(
                "composite_into_fp16: pixel count overflow: {width}x{height}"
            ))
        })?;
    let expected_len = pixel_count.checked_mul(4).ok_or_else(|| {
        crate::error::Error::Pipeline(format!(
            "composite_into_fp16: expected length overflow: {width}x{height}"
        ))
    })?;
    if in_fp16_rgba.len() != expected_len {
        return Err(crate::error::Error::Pipeline(format!(
            "composite_into_fp16: input length {} != {width}*{height}*4 = {expected_len}",
            in_fp16_rgba.len()
        )));
    }
    let mut img = Image {
        width,
        height,
        // Parallel endcaps (#1089 item 8), matching `apply_scene_linear_chain`:
        // the fp16 converters are scalar software routines, so both directions
        // are compute-bound. Pure element-wise maps, order-preserving, so the
        // output is bit-identical to the serial loops.
        pixels: in_fp16_rgba
            .par_chunks_exact(4)
            .map(|c| {
                [
                    f16_bits_to_f32(c[0]),
                    f16_bits_to_f32(c[1]),
                    f16_bits_to_f32(c[2]),
                ]
            })
            .collect(),
        space: ColorSpace::SceneLinearRec2020,
    };
    crate::stages::inpaint_composite::apply(&mut img, patches);
    let alpha_one = f32_to_f16_bits(1.0);
    let mut out: Vec<u16> = vec![0; expected_len];
    out.par_chunks_exact_mut(4)
        .zip(img.pixels.par_iter())
        .for_each(|(dst, p)| {
            dst[0] = f32_to_f16_bits(p[0]);
            dst[1] = f32_to_f16_bits(p[1]);
            dst[2] = f32_to_f16_bits(p[2]);
            dst[3] = alpha_one;
        });
    Ok(out)
}
