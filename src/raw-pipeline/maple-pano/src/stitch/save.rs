//! Bounded-memory save path for the finished composite: develop, quantize
//! and PNG-encode a block of rows at a time (#5451), straight from the
//! compositor's strips (#5452), so saving never holds a whole-canvas copy.

use std::ops::Range;
use std::path::PathBuf;

use crate::composite::CanvasSink;
use crate::error::PanoError;
use crate::ingest::PlanarImage;
use crate::png_output::PngRowWriter;
use crate::render::PngMetadata;

use super::sidecars::SidecarDownscaler;

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

/// Streams the finished composite to PNG as the compositor hands over its
/// strips (#5452). Each strip is developed and encoded a block of rows at a
/// time, so neither the canvas nor its developed copy is ever whole in
/// memory. Each PNG lands under its final name only in [`Self::finish`].
pub struct PngCanvasSink {
    display: Option<DisplayPng>,
    linear: Option<PathBuf>,
    open: Option<OpenOutputs>,
}

/// The finished, display-referred sRGB PNG.
pub struct DisplayPng {
    pub path: PathBuf,
    pub meta: PngMetadata,
    /// Also feed the developed rows to a [`SidecarDownscaler`].
    pub sidecars: bool,
}

struct OpenOutputs {
    display: Option<PngRowWriter>,
    linear: Option<PngRowWriter>,
    sidecars: Option<SidecarDownscaler>,
}

impl PngCanvasSink {
    /// `linear` is the scene-linear carrier.
    pub fn new(display: Option<DisplayPng>, linear: Option<PathBuf>) -> Self {
        Self {
            display,
            linear,
            open: None,
        }
    }

    /// Close the PNGs and hand back the sidecar downscaler, if one was fed.
    pub fn finish(self) -> Result<Option<SidecarDownscaler>, PanoError> {
        let open = self.open.ok_or_else(|| {
            PanoError::InvalidOptions("PNG sink finished before any canvas began".into())
        })?;
        open.display.map(PngRowWriter::finish).transpose()?;
        open.linear.map(PngRowWriter::finish).transpose()?;
        Ok(open.sidecars)
    }
}

impl CanvasSink for PngCanvasSink {
    fn begin(&mut self, width: u32, height: u32) -> Result<(), PanoError> {
        let display = self
            .display
            .as_ref()
            .map(|d| PngRowWriter::create(&d.path, width, height, &d.meta))
            .transpose()?;
        let linear = self
            .linear
            .as_ref()
            .map(|path| PngRowWriter::create(path, width, height, &PngMetadata::default()))
            .transpose()?;
        let sidecars = self
            .display
            .as_ref()
            .is_some_and(|d| d.sidecars)
            .then(|| SidecarDownscaler::new(width, height));
        self.open = Some(OpenOutputs {
            display,
            linear,
            sidecars,
        });
        Ok(())
    }

    fn rows(&mut self, strip: &PlanarImage) -> Result<(), PanoError> {
        let open = self.open.as_mut().ok_or_else(|| {
            PanoError::InvalidOptions("PNG sink got rows before the canvas began".into())
        })?;
        for y0 in (0..strip.height()).step_by(SAVE_BLOCK_ROWS as usize) {
            let block = y0..(y0 + SAVE_BLOCK_ROWS).min(strip.height());
            if let Some(writer) = &mut open.display {
                let developed = develop_rows_for_display(strip, block.clone());
                if let Some(sidecars) = &mut open.sidecars {
                    sidecars.push_rows(&developed);
                }
                writer.write_rows(&developed)?;
            }
            if let Some(writer) = &mut open.linear {
                writer.write_rows(&quantize_rows_linear(strip, block))?;
            }
        }
        Ok(())
    }
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

    fn decode_rgb16(path: &std::path::Path) -> (u32, u32, Vec<u16>) {
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

    /// Rows `rows` of `img` as their own image, the way a compositor hands
    /// over a strip.
    fn strip_of(img: &PlanarImage, rows: Range<u32>) -> PlanarImage {
        let w = img.width() as usize;
        let span = rows.start as usize * w..rows.end as usize * w;
        let h = rows.end - rows.start;
        PlanarImage::from_planes(
            img.width(),
            h,
            img.r[span.clone()].to_vec(),
            img.g[span.clone()].to_vec(),
            img.b[span].to_vec(),
            ValidityMask::new_filled(img.width(), h, true),
        )
    }

    /// Feed `img` to `sink` in strips of `strip_rows`, as a compositor would.
    fn stream(img: &PlanarImage, strip_rows: u32, sink: &mut PngCanvasSink) {
        sink.begin(img.width(), img.height()).unwrap();
        for y0 in (0..img.height()).step_by(strip_rows as usize) {
            let strip = strip_of(img, y0..(y0 + strip_rows).min(img.height()));
            sink.rows(&strip).unwrap();
        }
    }

    #[test]
    fn streamed_pngs_decode_to_the_whole_image_develop() {
        // 290-row strips taller than a block, and a ragged last strip.
        let pano = ramp_pano(41, 700);
        let (display, linear) = (tmp_png("display"), tmp_png("linear"));
        let meta = PngMetadata {
            exif_blob: None,
            tag_srgb: true,
        };
        let mut sink = PngCanvasSink::new(
            Some(DisplayPng {
                path: display.clone(),
                meta,
                sidecars: true,
            }),
            Some(linear.clone()),
        );
        stream(&pano, 290, &mut sink);
        assert!(!display.exists(), "the PNG lands only on finish");
        let sidecars = sink.finish().unwrap();

        let (w, h, shown) = decode_rgb16(&display);
        let (_, _, carrier) = decode_rgb16(&linear);
        let _ = std::fs::remove_file(&display);
        let _ = std::fs::remove_file(&linear);
        assert_eq!((w, h), (41, 700));
        assert_eq!(shown, develop_for_display(&pano));
        assert_eq!(carrier, quantize_to_u16(&pano, false));
        assert!(sidecars.is_some(), "the downscaler was fed");
    }

    #[test]
    fn a_short_stream_leaves_no_png_behind() {
        let pano = ramp_pano(19, 300);
        let path = tmp_png("short");
        let mut sink = PngCanvasSink::new(None, Some(path.clone()));
        sink.begin(pano.width(), pano.height()).unwrap();
        sink.rows(&strip_of(&pano, 0..100)).unwrap();
        assert!(sink.finish().is_err());
        assert!(!path.exists());
        assert!(!crate::png_output::partial_path(&path).exists());
    }

    #[test]
    fn rows_before_begin_are_refused() {
        let pano = ramp_pano(5, 4);
        let mut sink = PngCanvasSink::new(None, Some(tmp_png("early")));
        assert!(sink.rows(&pano).is_err());
        assert!(PngCanvasSink::new(None, None).finish().is_err());
    }
}
