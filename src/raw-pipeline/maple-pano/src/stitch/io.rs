//! I/O helpers for the stitch pipeline: frame interleaving for the ALIKED
//! detector and 16-bit PNG quantization.

use crate::ingest::PlanarImage;

/// Develop the scene-linear Rec.2020 composite into a DISPLAY-ENCODED sRGB
/// 16-bit packed-RGB buffer (row-major, R/G/B interleaved) — ready to hand
/// straight to `write_frame_png` as a finished, color-managed panorama (#1335).
///
/// The stitched composite lives in the working space — scene-linear Rec.2020.
/// Written raw (the old `srgb=false` path) it re-opened cold, desaturated and
/// flat: a non-RAW image is assumed display-encoded sRGB, so scene-linear
/// Rec.2020 data was mis-read on every axis (linear-as-gamma, Rec.2020-as-sRGB
/// primaries, no view transform).
///
/// This applies the SAME view tail raw-core uses to develop a RAW
/// (`pipeline/render`): **AgX** at neutral contrast (a stitched pano has no
/// embedded camera JPEG, so there is no Auto Profile to fit — AgX/Neutral is
/// the correct fallback), then **Rec.2020 → sRGB** primaries, then the **sRGB
/// OETF**, then quantizes to 16-bit. The result reads correctly in Maple and in
/// any viewer that assumes sRGB, consistent with how Maple develops RAWs.
///
/// Returns the packed 16-bit buffer directly rather than a `PlanarImage`: the
/// output is display-encoded sRGB, which would violate `PlanarImage`'s
/// scene-linear-Rec.2020 invariant, and quantizing straight from the
/// interleaved buffer avoids re-planarizing a second full-frame copy (peak RSS
/// matters on the 100MP+ pano, notably on iPad via the Apple FFI). The single
/// interleaved `raw_core::Image` copy is required by raw-core's view-tail API,
/// which operates on interleaved `[f32; 3]`.
pub fn develop_for_display(img: &PlanarImage) -> Vec<u16> {
    let n = img.pixel_count();

    // Interleave the planar scene-linear data into a raw_core::Image (the view
    // tail operates on interleaved [f32; 3]). NO clamp: AgX is a scene-referred
    // tone map and needs the extended highlight range (clamping to [0,1] first
    // would blow out highlights the curve should roll).
    let mut scene = raw_core::Image::new(
        img.width(),
        img.height(),
        raw_core::ColorSpace::SceneLinearRec2020,
    );
    for (px, i) in scene.pixels.iter_mut().zip(0..n) {
        *px = [img.r[i], img.g[i], img.b[i]];
    }

    // View tail, in raw-core's RAW-render order.
    raw_core::view::agx::apply(&mut scene, 0.0);
    raw_core::view::encode::rec2020_to_srgb(&mut scene);
    raw_core::view::encode::srgb_gamma_encode(&mut scene);

    // Quantize directly from the interleaved buffer (the sRGB OETF is already
    // applied; clamp guards any out-of-[0,1] residue from the gamut map).
    let mut data = Vec::with_capacity(n * 3);
    for px in &scene.pixels {
        for &v in &px[..3] {
            data.push((v.clamp(0.0, 1.0) * 65535.0).round() as u16);
        }
    }
    data
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

        // Packed 16-bit RGB: 3 pixels × 3 channels.
        let data = develop_for_display(&pano);
        assert_eq!(data.len(), 9);
        // pixel `p`, channel `c` → data[p*3 + c], normalised to [0, 1].
        let v = |p: usize, c: usize| data[p * 3 + c] as f32 / 65535.0;
        let (shadow, mid, high) = (v(0, 0), v(1, 0), v(2, 0));

        // Monotonic tone response: shadow < mid < highlight.
        assert!(
            shadow < mid && mid < high,
            "non-monotonic: {shadow} {mid} {high}"
        );
        // Grey in → grey out (gamut convert + AgX preserve neutrals).
        for p in 0..3 {
            assert!(
                (v(p, 0) - v(p, 1)).abs() < 1e-3,
                "neutral drift at pixel {p}"
            );
            assert!(
                (v(p, 0) - v(p, 2)).abs() < 1e-3,
                "neutral drift at pixel {p}"
            );
        }
        // AgX anchors mid-grey ~0.18 by design, so it ≈ a plain sRGB encode —
        // NOT where AgX shows. AgX shows on the HDR highlight: the +4.5-stop 4.0
        // input is ROLLED below clip-white by the AgX shoulder, whereas the OLD
        // path (clip to 1.0 → sRGB) returned exactly 1.0 for any input ≥ 1.0.
        assert!(
            high < 0.99,
            "HDR highlight should roll below clip-white via AgX, got {high}"
        );
        // Sanity: mid-grey lands in the expected AgX-anchored band (~0.46).
        assert!(
            (0.40..=0.52).contains(&mid),
            "mid-grey off AgX anchor: {mid}"
        );
    }
}
