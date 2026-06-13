//! I/O helpers for the stitch pipeline: frame interleaving for the ALIKED
//! detector and 16-bit PNG quantization.

use crate::ingest::PlanarImage;

/// Interleave a planar image into the ALIKED detector's packed-RGB f32 layout.
pub fn interleave_planar(img: &PlanarImage) -> Vec<f32> {
    let n = img.pixel_count();
    let mut out = Vec::with_capacity(n * 3);
    for i in 0..n {
        out.push(img.r[i]);
        out.push(img.g[i]);
        out.push(img.b[i]);
    }
    out
}

/// Quantize the scene-linear composite to a 16-bit packed RGB buffer
/// (row-major, R/G/B interleaved). Values are clamped to [0, 1].
/// Optionally applies IEC 61966 sRGB transfer for an eyeball-able preview.
pub fn quantize_to_u16(img: &PlanarImage, srgb: bool) -> Vec<u16> {
    let n = img.pixel_count();
    let mut data = Vec::with_capacity(n * 3);
    for i in 0..n {
        for plane in [&img.r, &img.g, &img.b] {
            let v = plane[i].clamp(0.0, 1.0);
            let v = if srgb { srgb_encode(v) } else { v };
            data.push((v * 65535.0).round() as u16);
        }
    }
    data
}

fn srgb_encode(v: f32) -> f32 {
    if v <= 0.003_130_8 {
        12.92 * v
    } else {
        1.055 * v.powf(1.0 / 2.4) - 0.055
    }
}
