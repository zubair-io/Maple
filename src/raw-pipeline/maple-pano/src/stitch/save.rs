//! Bounded-memory save path for the finished composite (#5451): develop,
//! quantize and PNG-encode a block of rows at a time, so saving never holds
//! a second whole-canvas copy of the panorama.

use std::ops::Range;
use std::path::Path;

use crate::error::PanoError;
use crate::ingest::PlanarImage;
use crate::png_output::PngRowWriter;
use crate::render::PngMetadata;

/// Rows developed per block: 128 rows of a 27k-wide canvas is ~40 MB of f32.
pub(crate) const SAVE_BLOCK_ROWS: u32 = 128;

/// Develop rows `rows` of the scene-linear Rec.2020 composite into
/// display-encoded sRGB 16-bit samples (row-major, RGB interleaved).
///
/// Same view tail raw-core uses to develop a RAW: AgX at neutral contrast,
/// Rec.2020 → sRGB primaries with gamut compression, the sRGB OETF, then
/// 16-bit quantization. Every step is per-pixel, so developing in blocks is
/// identical to developing the whole image at once.
pub(crate) fn develop_rows_for_display(img: &PlanarImage, rows: Range<u32>) -> Vec<u16> {
    let width = img.width() as usize;
    let pixels = rows.start as usize * width..rows.end as usize * width;
    let mut scene = raw_core::Image::new(
        img.width(),
        rows.end - rows.start,
        raw_core::ColorSpace::SceneLinearRec2020,
    );
    // NO clamp: AgX is a scene-referred tone map and needs the extended
    // highlight range.
    for (px, i) in scene.pixels.iter_mut().zip(pixels) {
        *px = [img.r[i], img.g[i], img.b[i]];
    }
    raw_core::view::agx::apply(&mut scene, 0.0, 0.0);
    raw_core::view::encode::rec2020_to_srgb(&mut scene);
    raw_core::view::encode::srgb_gamma_encode(&mut scene);
    scene
        .pixels
        .iter()
        .flat_map(|px| px.map(|v| (v.clamp(0.0, 1.0) * 65535.0).round() as u16))
        .collect()
}

/// Quantize rows `rows` of the scene-linear composite to 16-bit samples,
/// clamped to [0, 1], with no transfer curve (the scene-linear carrier).
pub(crate) fn quantize_rows_linear(img: &PlanarImage, rows: Range<u32>) -> Vec<u16> {
    let width = img.width() as usize;
    (rows.start as usize * width..rows.end as usize * width)
        .flat_map(|i| [img.r[i], img.g[i], img.b[i]])
        .map(|v| (v.clamp(0.0, 1.0) * 65535.0).round() as u16)
        .collect()
}

/// Write the finished, display-referred sRGB panorama PNG block by block.
/// `on_rows` sees every developed block in order (the sidecar downscaler
/// feeds on it), so nothing downstream needs the whole developed image.
pub fn write_display_png(
    img: &PlanarImage,
    path: &Path,
    meta: &PngMetadata,
    on_rows: impl FnMut(&[u16]),
) -> Result<(), PanoError> {
    write_blocks(img, path, meta, develop_rows_for_display, on_rows)
}

/// Write the scene-linear 16-bit carrier PNG block by block.
pub fn write_scene_linear_png(img: &PlanarImage, path: &Path) -> Result<(), PanoError> {
    write_blocks(
        img,
        path,
        &PngMetadata::default(),
        quantize_rows_linear,
        |_| {},
    )
}

fn write_blocks(
    img: &PlanarImage,
    path: &Path,
    meta: &PngMetadata,
    encode_rows: fn(&PlanarImage, Range<u32>) -> Vec<u16>,
    mut on_rows: impl FnMut(&[u16]),
) -> Result<(), PanoError> {
    let mut writer = PngRowWriter::create(path, img.width(), img.height(), meta)?;
    for y0 in (0..img.height()).step_by(SAVE_BLOCK_ROWS as usize) {
        let block = encode_rows(img, y0..(y0 + SAVE_BLOCK_ROWS).min(img.height()));
        on_rows(&block);
        writer.write_rows(&block)?;
    }
    writer.finish()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ingest::ValidityMask;
    use crate::stitch::quantize_to_u16;

    /// The pre-#5451 whole-image develop, kept verbatim as the reference the
    /// block-wise path must reproduce sample for sample.
    fn develop_for_display(img: &PlanarImage) -> Vec<u16> {
        let n = img.pixel_count();
        let mut scene = raw_core::Image::new(
            img.width(),
            img.height(),
            raw_core::ColorSpace::SceneLinearRec2020,
        );
        for (px, i) in scene.pixels.iter_mut().zip(0..n) {
            *px = [img.r[i], img.g[i], img.b[i]];
        }
        raw_core::view::agx::apply(&mut scene, 0.0, 0.0);
        raw_core::view::encode::rec2020_to_srgb(&mut scene);
        raw_core::view::encode::srgb_gamma_encode(&mut scene);
        let mut data = Vec::with_capacity(n * 3);
        for px in &scene.pixels {
            for &v in &px[..3] {
                data.push((v.clamp(0.0, 1.0) * 65535.0).round() as u16);
            }
        }
        data
    }

    fn ramp_pano(w: u32, h: u32) -> PlanarImage {
        let n = (w * h) as usize;
        let plane = |k: f32| {
            (0..n)
                .map(|i| (i as f32 * k).sin().abs() * 3.0)
                .collect::<Vec<_>>()
        };
        PlanarImage::from_planes(
            w,
            h,
            plane(0.013),
            plane(0.007),
            plane(0.019),
            ValidityMask::new_filled(w, h, true),
        )
    }

    fn tmp_png(label: &str) -> std::path::PathBuf {
        use std::sync::atomic::{AtomicU64, Ordering};
        static COUNTER: AtomicU64 = AtomicU64::new(0);
        let n = COUNTER.fetch_add(1, Ordering::Relaxed);
        std::env::temp_dir().join(format!(
            "maple_pano_save_{label}_{}_{n}.png",
            std::process::id()
        ))
    }

    fn decode_rgb16(path: &Path) -> (u32, u32, Vec<u16>) {
        let decoder =
            png::Decoder::new(std::io::BufReader::new(std::fs::File::open(path).unwrap()));
        let mut reader = decoder.read_info().unwrap();
        let mut buf = vec![0u8; reader.output_buffer_size()];
        let info = reader.next_frame(&mut buf).unwrap();
        let samples = buf[..info.buffer_size()]
            .chunks_exact(2)
            .map(|b| u16::from_be_bytes([b[0], b[1]]))
            .collect();
        (info.width, info.height, samples)
    }

    #[test]
    fn block_develop_matches_whole_image_develop() {
        // 300 rows spans two full blocks and a partial one.
        let pano = ramp_pano(37, 300);
        let blocks: Vec<u16> = (0..300)
            .step_by(SAVE_BLOCK_ROWS as usize)
            .flat_map(|y0| develop_rows_for_display(&pano, y0..(y0 + SAVE_BLOCK_ROWS).min(300)))
            .collect();
        assert_eq!(blocks, develop_for_display(&pano));
    }

    #[test]
    fn display_png_decodes_to_the_whole_image_develop() {
        let pano = ramp_pano(41, 290);
        let path = tmp_png("display");
        let mut seen = Vec::new();
        write_display_png(
            &pano,
            &path,
            &PngMetadata {
                exif_blob: None,
                tag_srgb: true,
            },
            |rows| seen.extend_from_slice(rows),
        )
        .unwrap();
        let (w, h, samples) = decode_rgb16(&path);
        let _ = std::fs::remove_file(&path);
        assert_eq!((w, h), (41, 290));
        let expected = develop_for_display(&pano);
        assert_eq!(samples, expected);
        assert_eq!(seen, expected, "on_rows must see every block in order");
    }

    #[test]
    fn scene_linear_png_decodes_to_the_whole_image_quantize() {
        let pano = ramp_pano(23, 260);
        let path = tmp_png("linear");
        write_scene_linear_png(&pano, &path).unwrap();
        let (_, _, samples) = decode_rgb16(&path);
        let _ = std::fs::remove_file(&path);
        assert_eq!(samples, quantize_to_u16(&pano, false));
    }
}
