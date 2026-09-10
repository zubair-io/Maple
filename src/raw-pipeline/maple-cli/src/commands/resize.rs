//! Standalone raster resizing command for `maple-cli`.

use raw_core::export::{encode_raster, ExportFormat};
use raw_core::raster::{decode_raster, resize_raster, FilterAlg, ResizeFit, ResizeOptions};
use std::error::Error;
use std::path::Path;

pub fn run(
    input: &Path,
    out: &Path,
    width: u32,
    height: u32,
    fit_str: &str,
    quality: u8,
) -> Result<i32, Box<dyn Error>> {
    if width == 0 || height == 0 {
        return Err("target width and height must be > 0".into());
    }

    let bytes = std::fs::read(input)?;
    let ext_hint = input.extension().and_then(|e| e.to_str());
    let raster = decode_raster(&bytes, ext_hint)?;

    let fit = match fit_str.to_ascii_lowercase().as_str() {
        "fill" => ResizeFit::Fill,
        _ => ResizeFit::Inside,
    };

    let opts = ResizeOptions {
        width,
        height,
        fit,
        filter: FilterAlg::Lanczos3,
        without_enlargement: true,
    };

    let resized = resize_raster(&raster, &opts)?;
    let out_ext = out.extension().and_then(|e| e.to_str()).unwrap_or("jpg");

    let format = ExportFormat::from_str(out_ext).unwrap_or(ExportFormat::Jpeg);
    let encoded = encode_raster(&resized, format, quality)?;

    std::fs::write(out, encoded)?;
    Ok(0)
}
