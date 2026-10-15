//! Transport Android's source-gamut pixels and ICC metadata into the shared core.
use half::f16;
use moxcms::{ColorProfile, ToneReprCurve, Xyzd};
use std::{fs::OpenOptions, path::Path};
use tiff::{
    encoder::{colortype::RGB32Float, TiffEncoder},
    tags::Tag,
};

pub fn stage(
    pixels: &[u8],
    width: u32,
    height: u32,
    stride: usize,
    format: u32,
    color: &[f32; 16],
    destination: &Path,
) -> Result<(), String> {
    let pixel_bytes = pixel_bytes(format)?;
    let row_bytes = (width as usize)
        .checked_mul(pixel_bytes)
        .ok_or("Invalid bitmap width")?;
    let needed = (height as usize)
        .checked_sub(1)
        .and_then(|h| h.checked_mul(stride))
        .and_then(|size| size.checked_add(row_bytes))
        .ok_or("Invalid bitmap size")?;
    if width == 0 || stride < row_bytes || pixels.len() < needed {
        return Err("Invalid floating bitmap layout".into());
    }
    if color.iter().any(|v| !v.is_finite()) {
        return Err("Invalid RGB color profile".into());
    }
    let mut profile = ColorProfile::new_srgb();
    let colorant = |i| Xyzd {
        x: color[i] as f64,
        y: color[i + 1] as f64,
        z: color[i + 2] as f64,
    };
    profile.red_colorant = colorant(0);
    profile.green_colorant = colorant(3);
    profile.blue_colorant = colorant(6);
    // Android supplies D50-adapted ICC PCS colorants and ICC type-4 EOTF parameters.
    profile.media_white_point = Some(profile.white_point);
    profile.red_trc = Some(if color[9..] == [1., 1., 0., 1., 0., 0., 0.] {
        ToneReprCurve::Lut(vec![]) // Exact signed identity, not a zero-clamped power curve.
    } else {
        ToneReprCurve::Parametric(color[9..].to_vec())
    });
    profile.green_trc = profile.red_trc.clone();
    profile.blue_trc = profile.red_trc.clone();
    profile.cicp = None;
    profile.description = None;
    let icc = profile.encode().map_err(|error| error.to_string())?;
    let file = OpenOptions::new()
        .create_new(true)
        .write(true)
        .open(destination)
        .map_err(|error| error.to_string())?;
    let mut encoder = TiffEncoder::new(file).map_err(|error| error.to_string())?;
    let mut image = encoder
        .new_image::<RGB32Float>(width, height)
        .map_err(|error| error.to_string())?;
    image.rows_per_strip(1).map_err(|error| error.to_string())?;
    image
        .encoder()
        .write_tag(Tag::IccProfile, icc.as_slice())
        .map_err(|error| error.to_string())?;
    let mut row = vec![0.0f32; width as usize * 3];
    for y in 0..height as usize {
        for (rgba, rgb) in pixels[y * stride..y * stride + row_bytes]
            .chunks_exact(pixel_bytes)
            .zip(row.chunks_exact_mut(3))
        {
            let pixel = match format {
                1 => std::array::from_fn(|c| rgba[c] as f32 / 255.),
                10 => {
                    let packed = u32::from_ne_bytes(rgba.try_into().unwrap());
                    [
                        (packed & 1023) as f32 / 1023.,
                        ((packed >> 10) & 1023) as f32 / 1023.,
                        ((packed >> 20) & 1023) as f32 / 1023.,
                        (packed >> 30) as f32 / 3.,
                    ]
                }
                9 => std::array::from_fn(|c| {
                    f16::from_bits(u16::from_ne_bytes([rgba[c * 2], rgba[c * 2 + 1]])).to_f32()
                }),
                _ => unreachable!(), // Validated before reading pixel memory.
            };
            if pixel.iter().any(|v| !v.is_finite()) || pixel[3] != 1.0 {
                return Err("Non-finite pixels or transparency are not supported".into());
            }
            rgb.copy_from_slice(&pixel[..3]);
        }
        image.write_strip(&row).map_err(|error| error.to_string())?;
    }
    image.finish().map_err(|error| error.to_string())
}

pub fn pixel_bytes(format: u32) -> Result<usize, String> {
    // NDK AndroidBitmapFormat values; no pixel conversion by the framework.
    match format {
        1 | 10 => Ok(4),
        9 => Ok(8),
        _ => Err("Unsupported decoded bitmap format".into()),
    }
}

#[cfg(test)]
pub(crate) fn test_profile(profile: ColorProfile, linear: bool) -> [f32; 16] {
    let mut values = [0.; 16];
    for (i, xyz) in [
        profile.red_colorant,
        profile.green_colorant,
        profile.blue_colorant,
    ]
    .iter()
    .enumerate()
    {
        values[i * 3..i * 3 + 3].copy_from_slice(&[xyz.x as f32, xyz.y as f32, xyz.z as f32]);
    }
    let trc = if linear {
        vec![1., 1., 0., 1., 0., 0., 0.]
    } else {
        vec![2.4, 1. / 1.055, 0.055 / 1.055, 1. / 12.92, 0.04045, 0., 0.]
    };
    values[9..].copy_from_slice(&trc);
    values
}

#[cfg(test)]
mod tests {
    use super::*;
    fn path(case: &str) -> std::path::PathBuf {
        std::env::temp_dir().join(format!("maple-f16-{case}-{}.tiff", std::process::id()))
    }

    #[test]
    fn float_stage_preserves_extended_gamut_precision_and_row_stride() {
        let destination = path("scene");
        let _ = std::fs::remove_file(&destination);
        let samples = [[1.5, -0.125, 0.0005, 1.0], [0.5005, 0.5, 0.5005, 1.0]];
        let row: Vec<u8> = samples
            .iter()
            .flatten()
            .flat_map(|v| f16::from_f32(*v).to_bits().to_ne_bytes())
            .chain([0u8; 8])
            .collect();
        let pixels = [row.clone(), row].concat();
        stage(
            &pixels,
            2,
            2,
            24,
            9,
            &test_profile(ColorProfile::new_srgb(), true),
            &destination,
        )
        .unwrap();
        let bytes = std::fs::read(&destination).unwrap();
        let (w, h, scene) =
            raw_core::pipeline::decode_raster_base(&bytes, 2048, raw_core::CancelToken::never())
                .unwrap();
        assert_eq!((w, h), (2, 2));
        for (index, pixel) in scene.chunks_exact(4).enumerate() {
            let input = samples[index % 2];
            let expected = raw_core::color::matrices::M_SRGB_TO_REC2020
                .mul_vec(std::array::from_fn(|i| f16::from_f32(input[i]).to_f32()));
            for channel in 0..3 {
                assert!(
                    (pixel[channel] - expected[channel]).abs() < 0.001,
                    "pixel {index} channel {channel}: {} vs {}",
                    pixel[channel],
                    expected[channel]
                );
            }
        }
        std::fs::remove_file(destination).unwrap();
    }

    #[test]
    fn float_stage_rejects_transparency_and_never_overwrites_existing_files() {
        let destination = path("protected");
        std::fs::write(&destination, b"original bytes").unwrap();
        let pixels: Vec<_> = [0.5, 0.5, 0.5, 0.5]
            .into_iter()
            .flat_map(|v| f16::from_f32(v).to_bits().to_ne_bytes())
            .collect();
        assert!(stage(
            &pixels,
            1,
            1,
            8,
            9,
            &test_profile(ColorProfile::new_srgb(), true),
            &destination
        )
        .is_err());
        assert_eq!(std::fs::read(&destination).unwrap(), b"original bytes");
        std::fs::remove_file(&destination).unwrap();
        assert!(stage(
            &pixels,
            1,
            1,
            8,
            9,
            &test_profile(ColorProfile::new_srgb(), true),
            &destination
        )
        .is_err());
        std::fs::remove_file(destination).unwrap();
    }

    #[test]
    fn packed_ten_bit_p3_preserves_source_gamut_and_precision() {
        let destination = path("p3-ten-bit");
        let _ = std::fs::remove_file(&destination);
        let samples = [[1023u32, 0, 0], [123, 345, 678]];
        let pixels: Vec<_> = samples
            .iter()
            .flat_map(|v| (v[0] | v[1] << 10 | v[2] << 20 | 3 << 30).to_ne_bytes())
            .collect();
        stage(
            &pixels,
            2,
            1,
            8,
            10,
            &test_profile(ColorProfile::new_display_p3(), false),
            &destination,
        )
        .unwrap();
        let (_, _, scene) = raw_core::pipeline::decode_raster_base(
            &std::fs::read(&destination).unwrap(),
            2048,
            raw_core::CancelToken::never(),
        )
        .unwrap();
        for (sample, pixel) in samples.iter().zip(scene.chunks_exact(4)) {
            let expected = raw_core::color::matrices::M_REC2020_TO_P3
                .inverse()
                .unwrap()
                .mul_vec(sample.map(|v| raw_core::view::encode::srgb_degamma(v as f32 / 1023.)));
            for c in 0..3 {
                assert!(
                    (pixel[c] - expected[c]).abs() < 0.001,
                    "{} vs {}",
                    pixel[c],
                    expected[c]
                );
            }
        }
        std::fs::remove_file(destination).unwrap();
    }

    #[test]
    fn rgba_eight_bit_transport_preserves_encoded_samples() {
        let destination = path("eight-bit");
        let _ = std::fs::remove_file(&destination);
        stage(
            &[13, 127, 238, 255],
            1,
            1,
            4,
            1,
            &test_profile(ColorProfile::new_srgb(), false),
            &destination,
        )
        .unwrap();
        let mut decoder =
            tiff::decoder::Decoder::new(std::io::Cursor::new(std::fs::read(&destination).unwrap()))
                .unwrap();
        let tiff::decoder::DecodingResult::F32(values) = decoder.read_image().unwrap() else {
            panic!("float TIFF expected")
        };
        assert_eq!(values, [13. / 255., 127. / 255., 238. / 255.]);
        std::fs::remove_file(destination).unwrap();
    }
}
