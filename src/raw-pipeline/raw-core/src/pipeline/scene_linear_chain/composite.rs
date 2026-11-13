use crate::error::Result;
use crate::image::{ColorSpace, Image};
use crate::pipeline::fp16::{f16_bits_to_f32, f32_to_f16_bits};
use rayon::prelude::*;

/// Composite synthetic-raw `patches` into an f32 RGBA scene-linear buffer at the
/// pre-user-grade seam, preserving input alpha.
pub fn composite_into_f32(
    in_f32_rgba: &[f32],
    width: u32,
    height: u32,
    patches: &[crate::types::InpaintPatch],
) -> Result<Vec<f32>> {
    composite_window_into_f32(in_f32_rgba, width, height, patches, [0.0, 0.0, 1.0, 1.0])
}

/// Source-window variant for un-oriented DefaultCrop detail tiles.
pub fn composite_window_into_f32(
    in_f32_rgba: &[f32],
    width: u32,
    height: u32,
    patches: &[crate::types::InpaintPatch],
    window: [f32; 4],
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
    if width == 0 || height == 0 || in_f32_rgba.len() != expected_len {
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
        nr_sampling_scale: 1.0,
        whites_anchor_ev: None,
    };
    crate::stages::inpaint_composite::apply_window(&mut img, patches, window)
        .map_err(crate::error::Error::Pipeline)?;
    let mut out = Vec::with_capacity(expected_len);
    for (p, input) in img.pixels.iter().zip(in_f32_rgba.chunks_exact(4)) {
        out.extend_from_slice(&[p[0], p[1], p[2], input[3]]);
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::InpaintPatch;

    #[test]
    fn source_window_wrappers_preserve_uncovered_pixels_and_alpha() {
        let patch = InpaintPatch {
            width: 1,
            height: 1,
            origin: [0.5, 0.0],
            extent: [0.5, 1.0],
            pixels: vec![[0.18, -0.125, 8.0]],
            coverage: vec![1.0],
        };
        let input = [-0.0, 0.2, 2.0, 0.5, 65504.0, -65504.0, 128.0, 0.25];
        let out = composite_window_into_f32(
            &input,
            2,
            1,
            std::slice::from_ref(&patch),
            [0.0, 0.0, 1.0, 1.0],
        )
        .unwrap();
        for i in 0..4 {
            assert_eq!(out[i].to_bits(), input[i].to_bits());
        }
        assert_eq!(&out[4..7], &patch.pixels[0]);
        assert_eq!(out[7], input[7]);
        let packed: Vec<_> = input.iter().map(|v| f32_to_f16_bits(*v)).collect();
        let out16 = composite_window_into_fp16(
            &packed,
            2,
            1,
            std::slice::from_ref(&patch),
            [0.0, 0.0, 1.0, 1.0],
        )
        .unwrap();
        assert_eq!(&out16[..4], &packed[..4]);
        assert_eq!(out16[7], packed[7]);
        let mut invalid = patch;
        invalid.pixels[0][0] = f32::NAN;
        assert!(composite_into_f32(&input, 2, 1, &[invalid]).is_err());
    }
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
    composite_window_into_fp16(in_fp16_rgba, width, height, patches, [0.0, 0.0, 1.0, 1.0])
}

/// Source-window variant for retained fp16 detail buffers.
pub fn composite_window_into_fp16(
    in_fp16_rgba: &[u16],
    width: u32,
    height: u32,
    patches: &[crate::types::InpaintPatch],
    window: [f32; 4],
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
    if width == 0 || height == 0 || in_fp16_rgba.len() != expected_len {
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
        nr_sampling_scale: 1.0,
        whites_anchor_ev: None,
    };
    crate::stages::inpaint_composite::apply_window(&mut img, patches, window)
        .map_err(crate::error::Error::Pipeline)?;
    // Size from the buffer actually being written rather than from
    // `expected_len`. The two are provably equal here — the guard above pins
    // `in_fp16_rgba.len() == expected_len`, `par_chunks_exact(4)` therefore
    // yields exactly `pixel_count` pixels, and `inpaint_composite::apply`
    // only mutates in place — but deriving the length from `img.pixels`
    // means the `zip` below cannot silently truncate or zero-pad if that
    // ever stops holding, and it matches `endcaps::pack_fp16`.
    let mut out: Vec<u16> = vec![0; img.pixels.len() * 4];
    out.par_chunks_exact_mut(4)
        .zip(img.pixels.par_iter())
        .zip(in_fp16_rgba.par_chunks_exact(4))
        .for_each(|((dst, p), input)| {
            dst[0] = f32_to_f16_bits(p[0]);
            dst[1] = f32_to_f16_bits(p[1]);
            dst[2] = f32_to_f16_bits(p[2]);
            dst[3] = input[3];
        });
    Ok(out)
}
