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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ingest::ValidityMask;

    /// `develop_for_display` must tone-map (AgX) and display-encode (sRGB) the
    /// scene-linear composite — not pass it through. Three grey scene-linear
    /// pixels (shadow / mid / blown highlight) must come back display-encoded,
    /// monotonic, in-gamut, and visibly shifted from a naive sRGB encode (i.e.
    /// AgX actually ran).
    #[test]
    fn develop_for_display_tone_maps_and_encodes() {
        let (w, h) = (3u32, 1u32);
        let planes = vec![0.02_f32, 0.18, 4.0]; // shadow, mid-grey, HDR highlight
        let pano = PlanarImage::from_planes(
            w,
            h,
            planes.clone(),
            planes.clone(),
            planes.clone(),
            ValidityMask::new_filled(w, h, true),
        );

        let out = develop_for_display(&pano);

        // Display-encoded: every value in [0, 1] (the highlight is rolled, not
        // left at its scene-linear 4.0).
        for v in out.r.iter().chain(&out.g).chain(&out.b) {
            assert!((0.0..=1.0).contains(v), "value out of display range: {v}");
        }
        // Monotonic tone response: shadow < mid < highlight.
        assert!(
            out.r[0] < out.r[1] && out.r[1] < out.r[2],
            "non-monotonic: {:?}",
            out.r
        );
        // Grey in → grey out (gamut convert + AgX preserve neutrals).
        for i in 0..3 {
            assert!((out.r[i] - out.g[i]).abs() < 1e-4, "neutral drift at {i}");
            assert!((out.r[i] - out.b[i]).abs() < 1e-4, "neutral drift at {i}");
        }
        // AgX anchors mid-grey ~0.18 by design, so 0.18 ≈ a plain sRGB encode —
        // that is NOT where AgX shows. AgX shows on the HDR highlight: the
        // +4.5-stop 4.0 input is ROLLED below clip-white by the AgX shoulder,
        // whereas the OLD display path (clip to 1.0 → sRGB) returned exactly
        // 1.0 for any input ≥ 1.0. So a highlight visibly below white proves
        // the view transform ran (not a clip+encode passthrough).
        assert!(
            out.r[2] < 0.99,
            "HDR highlight should roll below clip-white via AgX, got {}",
            out.r[2]
        );
        // Sanity: mid-grey lands in the expected AgX-anchored band (~0.46).
        assert!(
            (0.40..=0.52).contains(&out.r[1]),
            "mid-grey off AgX anchor: {}",
            out.r[1]
        );
    }
}
