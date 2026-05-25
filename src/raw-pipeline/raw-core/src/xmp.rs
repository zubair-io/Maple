//! XMP sidecar parser. The schema lives in [`crate::types`] — this module
//! is responsible only for translating `crs:`-flavoured XMP attributes into an
//! `AdjustmentModel` value.

use crate::error::{Error, Result};
use quick_xml::events::Event;
use quick_xml::reader::Reader;

// Re-export the canonical schema types so existing
// `use raw_core::xmp::{AdjustmentModel, HighlightRecoveryMode}` paths keep
// compiling. The single source of truth is `crate::types::adjustment`.
pub use crate::types::adjustment::{AdjustmentModel, HighlightRecoveryMode, Look};

/// Parse a `crs:`-style XMP sidecar. Unknown fields are ignored; known fields that
/// fail to parse numerically surface as an error.
pub fn parse(xml: &str) -> Result<AdjustmentModel> {
    let mut model = AdjustmentModel::default();
    let mut reader = Reader::from_str(xml);
    reader.config_mut().trim_text(true);

    loop {
        match reader.read_event() {
            Ok(Event::Empty(e)) | Ok(Event::Start(e)) => {
                for attr_result in e.attributes() {
                    let attr = attr_result.map_err(|e| Error::Xmp(e.to_string()))?;
                    let key = std::str::from_utf8(attr.key.as_ref())
                        .map_err(|e| Error::Xmp(e.to_string()))?;
                    let value = attr.unescape_value()
                        .map_err(|e| Error::Xmp(e.to_string()))?;
                    set_field(&mut model, key, &value)?;
                }
            }
            Ok(Event::Eof) => break,
            Err(e) => return Err(Error::Xmp(e.to_string())),
            _ => {}
        }
    }
    Ok(model)
}

fn set_field(m: &mut AdjustmentModel, key: &str, value: &str) -> Result<()> {
    let v = || value.parse::<f32>().map_err(|e| Error::Xmp(format!(
        "field {} has non-numeric value {}: {}", key, value, e
    )));
    match key {
        "crs:Temperature"    => m.temperature = v()?,
        "crs:Tint"           => m.tint        = v()?,
        "crs:Exposure2012"   => m.exposure    = v()?,
        "crs:Contrast2012"   => m.contrast    = v()?,
        "crs:Highlights2012" => m.highlights  = v()?,
        "crs:Shadows2012"    => m.shadows     = v()?,
        "crs:Whites2012"     => m.whites      = v()?,
        "crs:Blacks2012"     => m.blacks      = v()?,
        "crs:Vibrance"       => m.vibrance    = v()?,
        "crs:Saturation"     => m.saturation  = v()?,
        "crs:Clarity2012"    => m.clarity     = v()?,
        "crs:Texture"        => m.texture     = v()?,
        "crs:Sharpness"            => m.sharpen_amount  = v()?,
        "crs:SharpenRadius"        => m.sharpen_radius  = v()?,
        "crs:SharpenDetail"        => m.sharpen_detail  = v()?,
        "crs:SharpenEdgeMasking"   => m.sharpen_masking = v()?,
        // Capture sharpening (Richardson-Lucy deconvolution) — Maple-proprietary,
        // distinct from the reference renderer's `crs:Sharpness` unsharp-mask
        // sliders above. Lives under the `papp:` namespace because the
        // reference renderer has no equivalent control.
        "papp:CaptureSharpeningAmount" => m.capture_sharpening_amount = v()?,
        "papp:CaptureSharpeningRadius" => m.capture_sharpening_radius = v()?,
        "crs:LuminanceSmoothing"   => m.nr_luminance    = v()?,
        "crs:ColorNoiseReduction"  => m.nr_color        = v()?,
        "crs:Dehaze"         => m.dehaze      = v()?,
        "crs:WhiteBalance"   => {
            if let Some((temp, tint)) = wb_preset(value) {
                m.temperature = temp;
                m.tint = tint;
            }
            // Unknown WB names ("As Shot", "Auto", "Custom") leave defaults.
        }
        // Local adjustments (ticket #280). Slice 1 wire format: compact JSON
        // in a single attribute. Long-run goal is canonical
        // `crs:GradientBasedCorrections` nested-RDF — that requires a
        // separate XMP-walker extension.
        "papp:LocalAdjustments" => {
            m.local_adjustments =
                crate::types::local_adjustment::decode_local_adjustments(value)
                    .map_err(|e| Error::Xmp(format!("LocalAdjustments: {e}")))?;
        }
        "papp:HighlightRecoveryMode" => {
            m.highlight_recovery = match value {
                "off" | "Off" => HighlightRecoveryMode::Off,
                "blend" | "Blend" => HighlightRecoveryMode::Blend,
                "luminance" | "Luminance" => HighlightRecoveryMode::Luminance,
                "chromaticadaptation" | "ChromaticAdaptation" => {
                    HighlightRecoveryMode::ChromaticAdaptation
                }
                other => return Err(Error::Xmp(format!(
                    "unknown HighlightRecoveryMode: {}", other
                ))),
            };
        }
        // Display Look (ticket #371). Absent attribute -> the model default,
        // which is `Look::Neutral` under #397 (the Look is skipped while the
        // 4-tier DCP path is validated and a new Look is re-derived). An
        // explicit `papp:Look="Default"` still selects the #371 LUT.
        "papp:Look" => {
            m.look = match value {
                "neutral" | "Neutral" => Look::Neutral,
                "default" | "Default" => Look::Default,
                other => return Err(Error::Xmp(format!(
                    "unknown Look: {}", other
                ))),
            };
        }
        _ => {}, // Slices 1-2-3-4 ignore everything else.
    }
    Ok(())
}

/// Map a `crs:WhiteBalance` preset name to (temperature, tint).
/// Returns None for "As Shot", "Auto", "Custom", or unrecognized values —
/// the caller should leave AdjustmentModel defaults in those cases.
fn wb_preset(name: &str) -> Option<(f32, f32)> {
    match name {
        "Daylight"     => Some((5500.0,  10.0)),
        "Cloudy"       => Some((6500.0,  10.0)),
        "Shade"        => Some((7500.0,  10.0)),
        "Tungsten"     => Some((2850.0,   0.0)),
        "Fluorescent"  => Some((3800.0,  21.0)),
        "Flash"        => Some((5500.0,   0.0)),
        _              => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn load_fixture(rel: &str) -> Option<String> {
        let path = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../../../test-fixtures/references").join(rel);
        std::fs::read_to_string(path).ok()
    }

    #[test]
    fn defaults() {
        let m = AdjustmentModel::default();
        assert_eq!(m.temperature, 6500.0);
        assert_eq!(m.tint, 0.0);
        assert_eq!(m.exposure, 0.0);
        assert_eq!(m.contrast, 0.0);
        assert_eq!(m.highlights, 0.0);
        assert_eq!(m.shadows, 0.0);
        assert_eq!(m.whites, 0.0);
        assert_eq!(m.blacks, 0.0);
        assert_eq!(m.dehaze, 0.0);
    }

    #[test]
    fn parse_baseline_is_reference_defaults() {
        let xml = match load_fixture("test_0002/xmp/baseline.xmp") {
            Some(x) => x, None => return,
        };
        let m = parse(&xml).unwrap();
        // baseline.xmp is the camera's default reference-renderer sidecar,
        // which records the reference renderer's user-visible defaults
        // (Sharpness=40, SharpenRadius=1.0). As of #326,
        // `AdjustmentModel::default()` already encodes the reference-
        // renderer import baseline, so the explicit overrides below are
        // no-ops — we keep them spelled out to document what the test is
        // asserting and to fail loudly if a future commit shifts the
        // canonical defaults away from the reference renderer.
        let reference_defaults = AdjustmentModel {
            sharpen_amount: 40.0,
            sharpen_radius: 1.0,
            ..AdjustmentModel::default()
        };
        assert_eq!(m, reference_defaults);
    }

    #[test]
    fn parse_exposure_max() {
        let xml = match load_fixture("test_0002/xmp/exposure_max.xmp") {
            Some(x) => x, None => return,
        };
        let m = parse(&xml).unwrap();
        assert!(m.exposure > 0.5, "exposure was {}", m.exposure);
        assert_eq!(m.dehaze, 0.0);
    }

    #[test]
    fn parse_dehaze_max() {
        let xml = match load_fixture("test_0002/xmp/dehaze_max.xmp") {
            Some(x) => x, None => return,
        };
        let m = parse(&xml).unwrap();
        assert_eq!(m.dehaze, 100.0);
    }

    #[test]
    fn parse_wb_daylight_uses_preset() {
        let xml = match load_fixture("test_0002/xmp/wb_daylight.xmp") {
            Some(x) => x, None => return,
        };
        let m = parse(&xml).unwrap();
        assert!((m.temperature - 5500.0).abs() < 1.0,
            "expected 5500K from Daylight preset, got {}", m.temperature);
    }

    #[test]
    fn parse_wb_tungsten_uses_preset() {
        let xml = match load_fixture("test_0002/xmp/wb_tungsten.xmp") {
            Some(x) => x, None => return,
        };
        let m = parse(&xml).unwrap();
        assert!((m.temperature - 2850.0).abs() < 1.0,
            "expected 2850K from Tungsten preset, got {}", m.temperature);
    }

    #[test]
    fn explicit_temperature_overrides_preset() {
        // If both WhiteBalance and Temperature are present, explicit wins.
        let xml = r#"<?xml version="1.0"?><x><rdf:Description xmlns:rdf="x" xmlns:crs="x"
            crs:WhiteBalance="Daylight" crs:Temperature="3200"/></x>"#;
        let m = parse(xml).unwrap();
        assert!((m.temperature - 3200.0).abs() < 1.0);
    }

    #[test]
    fn unknown_wb_preset_leaves_defaults() {
        let xml = r#"<?xml version="1.0"?><x><rdf:Description xmlns:rdf="x" xmlns:crs="x"
            crs:WhiteBalance="As Shot"/></x>"#;
        let m = parse(xml).unwrap();
        assert_eq!(m.temperature, 6500.0);
        assert_eq!(m.tint, 0.0);
    }

    #[test]
    fn unknown_fields_are_ignored() {
        let xml = r#"<?xml version="1.0"?><x><rdf:Description xmlns:rdf="x" xmlns:crs="x"
            crs:Exposure2012="1.5" crs:SomeFutureField="99"/></x>"#;
        let m = parse(xml).unwrap();
        assert_eq!(m.exposure, 1.5);
    }

    #[test]
    fn defaults_includes_new_slice2_fields() {
        let m = AdjustmentModel::default();
        assert_eq!(m.contrast, 0.0);
        assert_eq!(m.highlights, 0.0);
        assert_eq!(m.shadows, 0.0);
        assert_eq!(m.whites, 0.0);
        assert_eq!(m.blacks, 0.0);
    }

    #[test]
    fn parse_contrast_max() {
        let xml = match load_fixture("test_0002/xmp/contrast_max.xmp") {
            Some(x) => x, None => return,
        };
        let m = parse(&xml).unwrap();
        assert_eq!(m.contrast, 100.0);
    }

    #[test]
    fn parse_highlights_min() {
        let xml = match load_fixture("test_0002/xmp/highlights_min.xmp") {
            Some(x) => x, None => return,
        };
        let m = parse(&xml).unwrap();
        assert_eq!(m.highlights, -100.0);
    }

    #[test]
    fn parse_shadows_max() {
        let xml = match load_fixture("test_0002/xmp/shadows_max.xmp") {
            Some(x) => x, None => return,
        };
        let m = parse(&xml).unwrap();
        assert_eq!(m.shadows, 100.0);
    }

    #[test]
    fn parse_whites_max() {
        let xml = match load_fixture("test_0002/xmp/whites_max.xmp") {
            Some(x) => x, None => return,
        };
        let m = parse(&xml).unwrap();
        assert_eq!(m.whites, 100.0);
    }

    #[test]
    fn parse_blacks_min() {
        let xml = match load_fixture("test_0002/xmp/blacks_min.xmp") {
            Some(x) => x, None => return,
        };
        let m = parse(&xml).unwrap();
        assert_eq!(m.blacks, -100.0);
    }

    #[test]
    fn defaults_includes_slice3_presence_fields() {
        let m = AdjustmentModel::default();
        assert_eq!(m.vibrance, 0.0);
        assert_eq!(m.saturation, 0.0);
        assert_eq!(m.clarity, 0.0);
        assert_eq!(m.texture, 0.0);
    }

    #[test]
    fn parse_vibrance_max() {
        let xml = match load_fixture("test_0002/xmp/vibrance_max.xmp") {
            Some(x) => x, None => return,
        };
        let m = parse(&xml).unwrap();
        assert_eq!(m.vibrance, 100.0);
    }

    #[test]
    fn parse_saturation_min() {
        let xml = match load_fixture("test_0002/xmp/saturation_min.xmp") {
            Some(x) => x, None => return,
        };
        let m = parse(&xml).unwrap();
        assert_eq!(m.saturation, -100.0);
    }

    #[test]
    fn parse_clarity_max() {
        let xml = match load_fixture("test_0002/xmp/clarity_max.xmp") {
            Some(x) => x, None => return,
        };
        let m = parse(&xml).unwrap();
        assert_eq!(m.clarity, 100.0);
    }

    #[test]
    fn parse_texture_min() {
        let xml = match load_fixture("test_0002/xmp/texture_min.xmp") {
            Some(x) => x, None => return,
        };
        let m = parse(&xml).unwrap();
        assert_eq!(m.texture, -100.0);
    }

    #[test]
    fn defaults_highlight_recovery_is_chromatic_adaptation() {
        // #335 flipped the default to `ChromaticAdaptation` after re-measuring
        // the parity harness: per-case Off-vs-CA diff shows the algorithm is
        // a near-noop on baseline fixtures (ΔΔE ≤ 0.001). Users can opt out
        // per-image via `papp:HighlightRecoveryMode="Off"` in the XMP sidecar.
        let m = AdjustmentModel::default();
        assert_eq!(
            m.highlight_recovery,
            HighlightRecoveryMode::ChromaticAdaptation
        );
    }

    #[test]
    fn parse_highlight_recovery_chromatic_adaptation() {
        let xml = r#"<?xml version="1.0"?><x><rdf:Description xmlns:rdf="x" xmlns:papp="x"
            papp:HighlightRecoveryMode="ChromaticAdaptation"/></x>"#;
        let m = parse(xml).unwrap();
        assert_eq!(
            m.highlight_recovery,
            HighlightRecoveryMode::ChromaticAdaptation
        );
    }

    #[test]
    fn parse_highlight_recovery_blend() {
        let xml = r#"<?xml version="1.0"?><x><rdf:Description xmlns:rdf="x" xmlns:papp="x"
            papp:HighlightRecoveryMode="blend"/></x>"#;
        let m = parse(xml).unwrap();
        assert_eq!(m.highlight_recovery, HighlightRecoveryMode::Blend);
    }

    #[test]
    fn parse_highlight_recovery_luminance() {
        let xml = r#"<?xml version="1.0"?><x><rdf:Description xmlns:rdf="x" xmlns:papp="x"
            papp:HighlightRecoveryMode="Luminance"/></x>"#;
        let m = parse(xml).unwrap();
        assert_eq!(m.highlight_recovery, HighlightRecoveryMode::Luminance);
    }

    #[test]
    fn parse_highlight_recovery_off_explicit() {
        let xml = r#"<?xml version="1.0"?><x><rdf:Description xmlns:rdf="x" xmlns:papp="x"
            papp:HighlightRecoveryMode="off"/></x>"#;
        let m = parse(xml).unwrap();
        assert_eq!(m.highlight_recovery, HighlightRecoveryMode::Off);
    }

    #[test]
    fn parse_highlight_recovery_invalid_is_error() {
        let xml = r#"<?xml version="1.0"?><x><rdf:Description xmlns:rdf="x" xmlns:papp="x"
            papp:HighlightRecoveryMode="typo"/></x>"#;
        assert!(parse(xml).is_err());
    }

    // -----------------------------------------------------------------
    // DisplayLookCurve (ticket #371).
    // -----------------------------------------------------------------

    #[test]
    fn defaults_look_is_neutral() {
        // Per #397: the default skips the Look. Mirrors the assertion in
        // `types::adjustment::tests` — duplicated here so the XMP module's
        // defaults invariant is self-contained.
        let m = AdjustmentModel::default();
        assert_eq!(m.look, Look::Neutral);
    }

    #[test]
    fn parse_look_neutral() {
        let xml = r#"<?xml version="1.0"?><x><rdf:Description xmlns:rdf="x" xmlns:papp="x"
            papp:Look="Neutral"/></x>"#;
        let m = parse(xml).unwrap();
        assert_eq!(m.look, Look::Neutral);
    }

    #[test]
    fn parse_look_default_explicit() {
        let xml = r#"<?xml version="1.0"?><x><rdf:Description xmlns:rdf="x" xmlns:papp="x"
            papp:Look="Default"/></x>"#;
        let m = parse(xml).unwrap();
        assert_eq!(m.look, Look::Default);
    }

    #[test]
    fn parse_look_lowercase() {
        // Case-insensitive parse mirrors the HighlightRecoveryMode pattern
        // so sidecars produced by either capitalization round-trip cleanly.
        let xml = r#"<?xml version="1.0"?><x><rdf:Description xmlns:rdf="x" xmlns:papp="x"
            papp:Look="neutral"/></x>"#;
        let m = parse(xml).unwrap();
        assert_eq!(m.look, Look::Neutral);
    }

    #[test]
    fn parse_look_absent_defaults_to_neutral() {
        // Sidecars without `papp:Look` pick up the model default, which is
        // `Look::Neutral` under #397. Verifies the parser leaves `look` at
        // the default when the attribute is missing.
        let xml = r#"<?xml version="1.0"?><x><rdf:Description xmlns:rdf="x" xmlns:papp="x"
            papp:HighlightRecoveryMode="Off"/></x>"#;
        let m = parse(xml).unwrap();
        assert_eq!(m.look, Look::Neutral);
    }

    #[test]
    fn parse_look_invalid_is_error() {
        let xml = r#"<?xml version="1.0"?><x><rdf:Description xmlns:rdf="x" xmlns:papp="x"
            papp:Look="Vivid"/></x>"#;
        assert!(parse(xml).is_err());
    }

    #[test]
    fn defaults_includes_slice5_detail_fields() {
        // Sharpen defaults match the reference renderer's fresh-import baseline per #326.
        let m = AdjustmentModel::default();
        assert_eq!(m.sharpen_amount, 40.0);
        assert_eq!(m.sharpen_radius, 1.0);
        assert_eq!(m.sharpen_detail, 25.0);
        assert_eq!(m.sharpen_masking, 0.0);
        assert_eq!(m.nr_luminance, 0.0);
        assert_eq!(m.nr_color, 25.0);
    }

    #[test]
    fn parse_sharpen_amount_max() {
        let xml = match load_fixture("test_0002/xmp/sharpen_amount_max.xmp") {
            Some(x) => x, None => return,
        };
        let m = parse(&xml).unwrap();
        assert!(m.sharpen_amount >= 100.0, "sharpen_amount = {}", m.sharpen_amount);
    }

    #[test]
    fn parse_sharpen_radius_max() {
        let xml = match load_fixture("test_0002/xmp/sharpen_radius_max.xmp") {
            Some(x) => x, None => return,
        };
        let m = parse(&xml).unwrap();
        assert!(m.sharpen_radius >= 2.9, "sharpen_radius = {}", m.sharpen_radius);
    }

    #[test]
    fn parse_sharpen_detail_min() {
        let xml = match load_fixture("test_0002/xmp/sharpen_detail_min.xmp") {
            Some(x) => x, None => return,
        };
        let m = parse(&xml).unwrap();
        assert!(m.sharpen_detail <= 0.5);
    }

    #[test]
    fn parse_sharpen_masking_max() {
        let xml = match load_fixture("test_0002/xmp/sharpen_masking_max.xmp") {
            Some(x) => x, None => return,
        };
        let m = parse(&xml).unwrap();
        assert_eq!(m.sharpen_masking, 100.0);
    }

    #[test]
    fn parse_nr_luminance_max() {
        let xml = match load_fixture("test_0002/xmp/nr_luminance_max.xmp") {
            Some(x) => x, None => return,
        };
        let m = parse(&xml).unwrap();
        assert_eq!(m.nr_luminance, 100.0);
    }

    #[test]
    fn parse_nr_color_max() {
        let xml = match load_fixture("test_0002/xmp/nr_color_max.xmp") {
            Some(x) => x, None => return,
        };
        let m = parse(&xml).unwrap();
        assert_eq!(m.nr_color, 100.0);
    }

    #[test]
    fn defaults_capture_sharpening_is_off() {
        let m = AdjustmentModel::default();
        assert_eq!(m.capture_sharpening_amount, 0.0);
        assert_eq!(m.capture_sharpening_radius, 1.0);
    }

    #[test]
    fn default_local_adjustments_is_empty() {
        let m = AdjustmentModel::default();
        assert!(m.local_adjustments.is_empty());
    }

    #[test]
    fn parse_local_adjustments_linear_round_trips() {
        use crate::types::local_adjustment::{
            encode_local_adjustments, LocalAdjustment, Mask, PartialAdjustments, Point2,
        };
        let layers = vec![LocalAdjustment {
            mask: Mask::Linear {
                start: Point2::new(0.0, 0.5),
                end: Point2::new(1.0, 0.5),
                feather: 0.5,
            },
            adjustments: PartialAdjustments {
                exposure: Some(1.0),
                ..Default::default()
            },
        }];
        let attr = encode_local_adjustments(&layers);
        // The attribute embeds JSON containing double-quotes; escape them
        // for the XML literal here.
        let escaped = attr.replace('"', "&quot;");
        let xml = format!(
            r#"<?xml version="1.0"?><x><rdf:Description xmlns:rdf="x" xmlns:papp="x"
                papp:LocalAdjustments="{escaped}"/></x>"#
        );
        let m = parse(&xml).expect("parse");
        assert_eq!(m.local_adjustments, layers);
    }

    #[test]
    fn parse_local_adjustments_malformed_errors() {
        let xml = r#"<?xml version="1.0"?><x><rdf:Description xmlns:rdf="x" xmlns:papp="x"
            papp:LocalAdjustments="{not json}"/></x>"#;
        assert!(parse(xml).is_err());
    }

    #[test]
    fn parse_capture_sharpening_attributes() {
        let xml = r#"<?xml version="1.0"?><x><rdf:Description xmlns:rdf="x" xmlns:papp="x"
            papp:CaptureSharpeningAmount="65" papp:CaptureSharpeningRadius="1.5"/></x>"#;
        let m = parse(xml).unwrap();
        assert_eq!(m.capture_sharpening_amount, 65.0);
        assert!((m.capture_sharpening_radius - 1.5).abs() < 1e-6);
    }
}
