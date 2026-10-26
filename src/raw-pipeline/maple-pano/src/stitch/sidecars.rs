//! The pano-injection pre-seed `.maple/` display derivatives, built from the
//! developed rows as they stream past the PNG encoder (#5451):
//!   • `.maple/thumbs/<basename>.avif` — 512 px grid thumb (#4793);
//!   • `.maple/previews/<basename>.avif` — 1280 px display preview (#2009),
//!     read by `MapleSidecarPaths.previewURL`. `<basename>` is the pano's
//!     output filename incl. extension (`MyPano.png` → `MyPano.png.avif`).
//!
//! The pre-seed only fills the gap before the pano is indexed through the
//! standard pipeline (which writes the real derivatives) — without it the
//! injected pano's grid tile / Preview is a blank ghost until then.

use image::{imageops::FilterType, DynamicImage, ImageBuffer, Rgb};

/// (subdir, target long edge, AVIF quality), both on the canonical
/// `<filename>.avif` name (#2009, #4793).
const VARIANTS: [(&str, u32, u8); 2] = [("thumbs", 512, 55), ("previews", 1280, 70)];

/// Long edge of the area-averaged intermediate, twice the largest variant so
/// the final Triangle resize still has real detail to filter.
const INTERMEDIATE_LONG_EDGE: u32 = 2 * VARIANTS[1].1;

/// Accumulates developed display rows (interleaved sRGB u16) into an
/// area-averaged intermediate at most [`INTERMEDIATE_LONG_EDGE`] px long, so
/// the derivatives never need the full-resolution developed image. A pano
/// already that small is kept exactly, so its derivatives match a direct
/// resize of the full image.
pub struct SidecarDownscaler {
    width: u32,
    height: u32,
    inter_w: u32,
    inter_h: u32,
    col_bucket: Vec<u32>,
    sums: Vec<u64>,
    counts: Vec<u32>,
    next_row: u32,
}

/// One encoded-ready derivative: subdir, size and 8-bit RGB pixels.
struct Derivative {
    subdir: &'static str,
    width: u32,
    height: u32,
    rgb8: Vec<u8>,
    quality: u8,
}

impl SidecarDownscaler {
    pub fn new(width: u32, height: u32) -> Self {
        let (inter_w, inter_h) = fit_long_edge(width, height, INTERMEDIATE_LONG_EDGE);
        let col_bucket = (0..width).map(|x| bucket(x, width, inter_w)).collect();
        let cells = inter_w as usize * inter_h as usize;
        Self {
            width,
            height,
            inter_w,
            inter_h,
            col_bucket,
            sums: vec![0; cells * 3],
            counts: vec![0; cells],
            next_row: 0,
        }
    }

    /// Feed the next whole rows of developed samples, top to bottom.
    pub fn push_rows(&mut self, samples: &[u16]) {
        let row_samples = self.width as usize * 3;
        for row in samples.chunks_exact(row_samples) {
            let row_base =
                bucket(self.next_row, self.height, self.inter_h) as usize * self.inter_w as usize;
            for (x, px) in row.chunks_exact(3).enumerate() {
                let cell = row_base + self.col_bucket[x] as usize;
                self.counts[cell] += 1;
                for (c, &v) in px.iter().enumerate() {
                    self.sums[cell * 3 + c] += u64::from(v);
                }
            }
            self.next_row += 1;
        }
    }

    /// Encode and write both derivatives beside `png_path`. Non-fatal to the
    /// caller: the stitch has already succeeded when this runs.
    pub fn write(self, png_path: &std::path::Path) -> Result<(), String> {
        let basename = png_path
            .file_name()
            .and_then(|s| s.to_str())
            .ok_or_else(|| format!("bad pano path: {png_path:?}"))?;
        let filename = format!("{basename}.avif");
        let parent = png_path
            .parent()
            .unwrap_or_else(|| std::path::Path::new("."));
        for d in self.derivatives()? {
            let encoded = raw_core::avif::encode(d.width, d.height, &d.rgb8, d.quality)
                .map_err(|e| e.to_string())?;
            let dir = parent.join(".maple").join(d.subdir);
            std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
            std::fs::write(dir.join(&filename), encoded).map_err(|e| e.to_string())?;
        }
        Ok(())
    }

    fn derivatives(self) -> Result<Vec<Derivative>, String> {
        if self.next_row != self.height {
            return Err(format!(
                "sidecar downscaler saw {} of {} rows",
                self.next_row, self.height
            ));
        }
        let averaged: Vec<u16> = self
            .sums
            .iter()
            .enumerate()
            .map(|(i, &sum)| {
                let n = u64::from(self.counts[i / 3]);
                ((sum + n / 2) / n) as u16
            })
            .collect();
        let inter = ImageBuffer::<Rgb<u16>, _>::from_raw(self.inter_w, self.inter_h, averaged)
            .ok_or_else(|| "intermediate buffer length mismatch".to_string())?;
        Ok(VARIANTS
            .iter()
            .map(|&(subdir, target, quality)| {
                let (width, height) = fit_long_edge(self.width, self.height, target);
                let resized = if (width, height) == (self.inter_w, self.inter_h) {
                    inter.clone()
                } else {
                    image::imageops::resize(&inter, width, height, FilterType::Triangle)
                };
                Derivative {
                    subdir,
                    width,
                    height,
                    rgb8: DynamicImage::ImageRgb16(resized).into_rgb8().into_raw(),
                    quality,
                }
            })
            .collect())
    }
}

/// Map a source coordinate onto `inter` buckets spread evenly over `src`.
fn bucket(v: u32, src: u32, inter: u32) -> u32 {
    (u64::from(v) * u64::from(inter) / u64::from(src)) as u32
}

/// Fit `(width, height)` to a max long edge, preserving aspect, never upscaling.
fn fit_long_edge(width: u32, height: u32, target: u32) -> (u32, u32) {
    let long = width.max(height);
    if long <= target {
        return (width, height);
    }
    let scale = target as f64 / long as f64;
    let w = ((width as f64 * scale).round() as u32).max(1);
    let h = ((height as f64 * scale).round() as u32).max(1);
    (w, h)
}

#[cfg(test)]
#[path = "sidecars_tests.rs"]
mod tests;
