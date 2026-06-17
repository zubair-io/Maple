//! I/O helpers for the stitch pipeline: frame interleaving for the ALIKED
//! detector and 16-bit PNG quantization.

use crate::ingest::{PlanarImage, ValidityMask};

/// Develop the scene-linear Rec.2020 composite into a DISPLAY-ENCODED sRGB
/// `PlanarImage`, ready to write as a finished, color-managed panorama (#1335).
///
/// The stitched composite lives in the working space — scene-linear Rec.2020.
/// Writing it raw (the old `srgb=false` path) made the app re-open it cold,
/// desaturated and flat: a non-RAW image is assumed display-encoded sRGB, so
/// scene-linear Rec.2020 data was mis-read on every axis (linear-as-gamma,
/// Rec.2020-as-sRGB primaries, no view transform).
///
/// This applies the SAME view tail raw-core uses to develop a RAW
/// (`pipeline/render`): **AgX** at neutral contrast (a stitched pano has no
/// embedded camera JPEG, so there is no Auto Profile to fit — AgX/Neutral is
/// the correct fallback), then **Rec.2020 → sRGB** primaries, then the **sRGB
/// OETF**. The result is a correct display-referred sRGB image, consistent with
/// how Maple develops RAWs, and read correctly by any viewer that assumes sRGB.
///
/// Quantize the result with `srgb = false` — the OETF is already applied here.
pub fn develop_for_display(img: &PlanarImage) -> PlanarImage {
    let n = img.pixel_count();
    let w = img.width();
    let h = img.height();

    // Interleave the planar scene-linear data into a raw_core::Image. NO clamp:
    // AgX is a scene-referred tone map and needs the extended highlight range
    // (clamping to [0,1] first would blow out highlights the curve should roll).
    let mut scene = raw_core::Image::new(w, h, raw_core::ColorSpace::SceneLinearRec2020);
    for (px, i) in scene.pixels.iter_mut().zip(0..n) {
        *px = [img.r[i], img.g[i], img.b[i]];
    }

    // View tail, in raw-core's RAW-render order.
    raw_core::view::agx::apply(&mut scene, 0.0);
    raw_core::view::encode::rec2020_to_srgb(&mut scene);
    raw_core::view::encode::srgb_gamma_encode(&mut scene);

    // Planarize back. Values are display-encoded sRGB in [0, 1].
    let mut r = Vec::with_capacity(n);
    let mut g = Vec::with_capacity(n);
    let mut b = Vec::with_capacity(n);
    for p in &scene.pixels {
        r.push(p[0]);
        g.push(p[1]);
        b.push(p[2]);
    }
    PlanarImage::from_planes(w, h, r, g, b, ValidityMask::new_filled(w, h, true))
}

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
