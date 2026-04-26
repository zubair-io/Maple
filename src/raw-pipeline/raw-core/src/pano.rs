//! Panorama-ingest entry point (spec § 4.1).
//!
//! Wraps the `raw-core` pipeline up to and including DCP, producing a
//! scene-linear Rec.2020 D65 buffer suitable for `pano-core` to consume.
//! Skips the display-prep stages — capture sharpening biases feature
//! matching, and histogram match against an embedded preview defeats
//! pairwise gain compensation downstream.
//!
//! See `docs/tickets/04-maple-panorama-spec.md` § 4.1 for the rationale.

use crate::color::dcp;
use crate::demosaic;
use crate::image::{CfaPattern, ExifOrientation, Image, RawImage};
use crate::linearize;
use crate::Result;

/// Bundle returned by [`decode_for_pano`] — the post-DCP scene-linear
/// image plus the metadata pano-core needs to interpret it.
#[derive(Clone, Debug)]
pub struct PanoIngest {
    /// Scene-linear Rec.2020 D65, f32 RGB. Display orientation is **not**
    /// applied here — the caller (pano-core) rotates while converting to
    /// its own buffer layout.
    pub image: Image,
    pub orientation: ExifOrientation,
    pub camera_make: String,
    pub camera_model: String,
}

/// Run the raw → camera RGB → DCP chain on a `RawImage` and return the
/// scene-linear Rec.2020 D65 buffer. No user adjustments — vibrance,
/// saturation, clarity, etc. are intentionally skipped.
pub fn develop_for_pano(raw: &RawImage) -> Result<Image> {
    let mut camera_rgb = match raw.cfa {
        CfaPattern::LinearRgb => linearize::linearraw_to_camera_rgb(raw)?,
        _ => {
            let mosaic = linearize::sensor_linearize(raw);
            demosaic::bilinear(&mosaic, raw.cfa)
        }
    };

    if raw.baseline_exposure.abs() > 1e-4 {
        let be_gain = raw.baseline_exposure.exp2();
        for p in &mut camera_rgb.pixels {
            p[0] *= be_gain;
            p[1] *= be_gain;
            p[2] *= be_gain;
        }
    }

    let profile = dcp::profile_for(raw)?;
    dcp::apply(&camera_rgb, &profile)
}

/// Decode a RAW from in-memory bytes and run [`develop_for_pano`] in
/// one shot. `ext` is the lowercase file extension used by rawler as a
/// format hint (matching [`crate::decode::decode_bytes`]).
pub fn decode_for_pano(bytes: &[u8], ext: &str) -> Result<PanoIngest> {
    let raw = crate::decode::decode_bytes(bytes, ext)?;
    let image = develop_for_pano(&raw)?;
    Ok(PanoIngest {
        image,
        orientation: raw.orientation,
        camera_make: raw.camera_make,
        camera_model: raw.camera_model,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::color::illuminant::Illuminant;
    use crate::image::ColorSpace;
    use crate::math::Matrix3;
    use std::collections::HashMap;

    fn synth_linear_rgb_raw() -> RawImage {
        // Canon-shape color matrix (XYZ→camera, D65). Same shape used in
        // the existing dcp tests. Pixel value 50% gray.
        let cm = Matrix3([
            [0.6722, -0.0635, -0.0963],
            [-0.4287, 1.2460, 0.2028],
            [-0.0908, 0.2162, 0.5668],
        ]);
        let mut cms = HashMap::new();
        cms.insert(Illuminant::D65, cm);

        let as_shot_neutral = [1.65, 1.0, 2.16]; // warm WB

        // 2×2 LinearRgb image — 12 u16 entries (3 channels × 4 pixels).
        // Values in 0..white_level=1024 range; `linearraw_to_camera_rgb`
        // will normalize to f32 in [0, 1] then apply the AsShotNeutral
        // pre-bake undo.
        RawImage {
            width: 2,
            height: 2,
            cfa: CfaPattern::LinearRgb,
            black_level: [0; 4],
            white_level: 1024,
            raw_data: vec![512; 12], // mid-gray
            as_shot_neutral,
            as_shot_cct: None,
            camera_make: "Test".into(),
            camera_model: "Test".into(),
            color_matrices: cms,
            orientation: ExifOrientation::Normal,
            baseline_exposure: 0.0,
        }
    }

    #[test]
    fn develop_for_pano_returns_scene_linear_rec2020() {
        let raw = synth_linear_rgb_raw();
        let img = develop_for_pano(&raw).expect("DCP applies");
        assert_eq!(img.space, ColorSpace::SceneLinearRec2020);
        assert_eq!(img.width, 2);
        assert_eq!(img.height, 2);
        assert_eq!(img.pixels.len(), 4);
    }

    #[test]
    fn develop_for_pano_neutral_input_yields_neutral_rec2020() {
        // Mid-gray neutral camera RGB should come out roughly neutral in
        // Rec.2020 — same as the existing dcp test, just exercised
        // through the panorama wrapper.
        let raw = synth_linear_rgb_raw();
        let img = develop_for_pano(&raw).expect("DCP applies");
        let p = img.pixels[0];
        let rg = (p[0] - p[1]).abs();
        let bg = (p[2] - p[1]).abs();
        // Looser tolerance than the dcp test because we're going through
        // the linearize → camera_rgb path which has its own quantization.
        assert!(
            rg < 0.05 && bg < 0.05,
            "expected near-neutral, got RGB = ({:.4}, {:.4}, {:.4})",
            p[0],
            p[1],
            p[2],
        );
    }

    #[test]
    fn develop_for_pano_baseline_exposure_brightens() {
        let mut raw = synth_linear_rgb_raw();
        let baseline = develop_for_pano(&raw).unwrap();
        let baseline_g = baseline.pixels[0][1];

        raw.baseline_exposure = 1.0; // +1 EV → 2× gain
        let brighter = develop_for_pano(&raw).unwrap();
        let brighter_g = brighter.pixels[0][1];

        assert!(
            brighter_g > baseline_g * 1.5,
            "expected +1 EV to roughly double green; baseline={}, brighter={}",
            baseline_g,
            brighter_g,
        );
    }
}
