//! Pixel-buffer I/O helpers for [`super`] (`pano stitch`). Split from
//! `pano/mod.rs` for the file-size budget.

use std::path::Path;

use maple_pano::ingest::PlanarImage;
use maple_pano::render::write_frame_png;

/// Interleave a planar image into the detector's RGB f32 layout.
pub(super) fn interleave(img: &PlanarImage) -> Vec<f32> {
    let n = img.pixel_count();
    let mut out = Vec::with_capacity(n * 3);
    for i in 0..n {
        out.push(img.r[i]);
        out.push(img.g[i]);
        out.push(img.b[i]);
    }
    out
}

/// Quantize the composite to 16-bit PNG. `srgb` applies the IEC 61966
/// transfer for an eyeball-able preview; otherwise values stay linear
/// (clamped to [0, 1] — the PNG carries the display-range slice of the
/// scene; the DNG writer of spec step 9 is the full-range carrier).
pub(super) fn write_png16(path: &Path, img: &PlanarImage, srgb: bool) -> Result<(), String> {
    let n = img.pixel_count();
    let mut data = Vec::with_capacity(n * 3);
    for i in 0..n {
        for plane in [&img.r, &img.g, &img.b] {
            let v = plane[i].clamp(0.0, 1.0);
            let v = if srgb { srgb_encode(v) } else { v };
            data.push((v * 65535.0).round() as u16);
        }
    }
    write_frame_png(path, img.width(), img.height(), &data)
        .map_err(|e| format!("{}: {e}", path.display()))
}

fn srgb_encode(v: f32) -> f32 {
    if v <= 0.003_130_8 {
        12.92 * v
    } else {
        1.055 * v.powf(1.0 / 2.4) - 0.055
    }
}
