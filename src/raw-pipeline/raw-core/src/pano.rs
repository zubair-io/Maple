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
    /// Drone gimbal angles in degrees, when the source image is from
    /// a DJI drone (or any device that writes drone-dji XMP). `None`
    /// otherwise.
    pub gimbal: Option<GimbalAngles>,
}

/// Gimbal orientation angles recorded by a DJI drone into the
/// `drone-dji` XMP namespace (`GimbalYawDegree`, `GimbalPitchDegree`,
/// `GimbalRollDegree`). All values are in degrees.
#[derive(Debug, Clone, Copy)]
pub struct GimbalAngles {
    pub yaw_deg: f32,
    pub pitch_deg: f32,
    pub roll_deg: f32,
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

    // ── Gimbal angles from embedded XMP ──────────────────────────────────────
    // DJI DNGs embed a drone-dji XMP packet inside TIFF tag 0x02BC (700).
    // Strategy: extract XMP bytes from rawler's root IFD via TiffCommonTag::Xmp,
    // then grep for the three gimbal keys. This path is entirely optional —
    // any failure leaves `gimbal: None`.
    //
    // Implementation note: rawler's decoder exposes the root IFD but does not
    // offer a high-level `xmp()` accessor. We read tag 700 directly via the
    // same WellKnownIFD::Root + get_entry pattern used in decode.rs for
    // BaselineExposure. The `tiff` workspace crate is NOT needed because rawler
    // already parses the TIFF structure for us; its Value::Byte variant holds
    // the raw XMP UTF-8 bytes.
    let gimbal = extract_xmp_from_bytes(bytes)
        .as_deref()
        .and_then(extract_gimbal_from_xmp);

    Ok(PanoIngest {
        image,
        orientation: raw.orientation,
        camera_make: raw.camera_make,
        camera_model: raw.camera_model,
        gimbal,
    })
}

/// Extract the raw XMP packet from the input bytes.
///
/// Attempts two strategies in order:
/// 1. **rawler root IFD** — ask rawler's decoder for tag 0x02BC (`TiffCommonTag::Xmp`).
///    This is the cleanest path and works for all DNG/TIFF-container formats.
/// 2. **Byte scan fallback** — scan the raw bytes for the literal `<x:xmpmeta`
///    ... `</x:xmpmeta>` packet, which DJI embeds as plain UTF-8. This is
///    tolerant of formats where rawler's IFD parse doesn't surface tag 700.
fn extract_xmp_from_bytes(bytes: &[u8]) -> Option<String> {
    // Strategy 1: rawler root IFD, tag 700
    {
        use rawler::decoders::{RawDecodeParams, WellKnownIFD};
        use rawler::rawsource::RawSource;
        use rawler::tags::TiffCommonTag;

        let source = RawSource::new_from_slice(bytes).with_path(
            std::path::Path::new("rawfile.dng"),
        );
        let _params = RawDecodeParams::default();
        if let Some(decoder) = rawler::get_decoder(&source).ok() {
            if let Some(ifd) = decoder.ifd(WellKnownIFD::Root).ok().flatten() {
                if let Some(entry) = ifd.get_entry(TiffCommonTag::Xmp) {
                    let xmp_bytes = entry.value.get_data();
                    if let Ok(s) = std::str::from_utf8(xmp_bytes) {
                        return Some(s.to_string());
                    }
                }
            }
        }
    }

    // Strategy 2: scan raw bytes for the XMP packet start/end markers.
    // DJI embeds XMP as plain ASCII/UTF-8 directly in the TIFF stream.
    let s = std::str::from_utf8(bytes).ok()?;
    let start = s.find("<x:xmpmeta")?;
    let end = s[start..].find("</x:xmpmeta>").map(|i| start + i + 12)?;
    Some(s[start..end].to_string())
}

/// Parse the three DJI gimbal angle fields from an XMP string.
///
/// Returns `None` if any of the three fields is absent or unparseable.
fn extract_gimbal_from_xmp(xmp: &str) -> Option<GimbalAngles> {
    let yaw = grep_dji_attr(xmp, "GimbalYawDegree")?;
    let pitch = grep_dji_attr(xmp, "GimbalPitchDegree")?;
    let roll = grep_dji_attr(xmp, "GimbalRollDegree")?;
    Some(GimbalAngles {
        yaw_deg: yaw,
        pitch_deg: pitch,
        roll_deg: roll,
    })
}

/// Tolerant grep for a DJI XMP attribute value.
///
/// DJI writes gimbal fields in two forms:
/// - Element:   `<drone-dji:GimbalYawDegree>+87.9</drone-dji:GimbalYawDegree>`
/// - Attribute: `drone-dji:GimbalYawDegree="+87.9"`
///
/// Both contain `GimbalYawDegree` followed (eventually) by a signed decimal.
/// We skip punctuation/whitespace after the key name, then collect the first
/// signed numeric token.
fn grep_dji_attr(xmp: &str, key: &str) -> Option<f32> {
    let idx = xmp.find(key)?;
    let after = &xmp[idx + key.len()..];
    let mut chars = after.chars().peekable();
    // Skip non-numeric characters until the start of a signed decimal token.
    while let Some(&c) = chars.peek() {
        if c == '+' || c == '-' || c.is_ascii_digit() {
            break;
        }
        chars.next();
    }
    let mut buf = String::new();
    for c in chars {
        if c == '+' || c == '-' || c.is_ascii_digit() || c == '.' || c == 'e' || c == 'E' {
            buf.push(c);
        } else if !buf.is_empty() {
            break;
        }
    }
    buf.parse().ok()
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

    #[test]
    fn grep_dji_attr_element_form() {
        let xmp = r#"<drone-dji:GimbalYawDegree>+87.9</drone-dji:GimbalYawDegree>"#;
        let v = super::grep_dji_attr(xmp, "GimbalYawDegree").expect("should parse");
        assert!((v - 87.9).abs() < 0.01, "got {}", v);
    }

    #[test]
    fn grep_dji_attr_attribute_form() {
        let xmp = r#"drone-dji:GimbalPitchDegree="-1.3""#;
        let v = super::grep_dji_attr(xmp, "GimbalPitchDegree").expect("should parse");
        assert!((v + 1.3).abs() < 0.01, "got {}", v);
    }

    #[test]
    fn grep_dji_attr_zero() {
        let xmp = r#"<drone-dji:GimbalRollDegree>+0.0</drone-dji:GimbalRollDegree>"#;
        let v = super::grep_dji_attr(xmp, "GimbalRollDegree").expect("should parse");
        assert!(v.abs() < 0.01, "got {}", v);
    }

    #[test]
    fn extract_gimbal_from_xmp_full_packet() {
        let xmp = r#"<x:xmpmeta xmlns:x="adobe:ns:meta/">
          <rdf:RDF>
            <rdf:Description
              drone-dji:GimbalYawDegree="+87.9"
              drone-dji:GimbalPitchDegree="-1.3"
              drone-dji:GimbalRollDegree="+0.0"
            />
          </rdf:RDF>
        </x:xmpmeta>"#;
        let g = super::extract_gimbal_from_xmp(xmp).expect("should parse gimbal");
        assert!((g.yaw_deg - 87.9).abs() < 0.01);
        assert!((g.pitch_deg + 1.3).abs() < 0.01);
        assert!(g.roll_deg.abs() < 0.01);
    }

    #[test]
    #[ignore] // fixture-gated — requires test-fixtures/raws/pano_01/
    fn pano_01_dng_exposes_gimbal_angles() {
        let path = std::path::Path::new(
            "/Users/riabuz/Projects/_Maple/test-fixtures/raws/pano_01/PANO0001.DNG",
        );
        if !path.exists() { return; }
        let bytes = std::fs::read(path).unwrap();
        let ingest = decode_for_pano(&bytes, "dng").unwrap();
        let gimbal = ingest.gimbal.expect("expected gimbal angles in DJI DNG");
        assert!((gimbal.yaw_deg - 87.9).abs() < 0.5, "yaw={}", gimbal.yaw_deg);
        assert!((gimbal.pitch_deg + 1.3).abs() < 0.5, "pitch={}", gimbal.pitch_deg);
        assert!((gimbal.roll_deg - 0.0).abs() < 0.5, "roll={}", gimbal.roll_deg);
    }
}
