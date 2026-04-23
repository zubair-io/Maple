use crate::error::{Error, Result};
use quick_xml::events::Event;
use quick_xml::reader::Reader;

/// Slice 1+2 subset of `AdjustmentModel`. See spec § 01 for the full shape.
#[derive(Clone, Debug, PartialEq)]
pub struct AdjustmentModel {
    pub temperature: f32, // 2000..12000, default 6500
    pub tint: f32,        // -100..100, default 0
    pub exposure: f32,    // -4..+4 EV, default 0
    pub contrast: f32,    // -100..100, default 0 (routed to AgX slope per spec § 3.6a)
    pub highlights: f32,  // -100..100, default 0
    pub shadows: f32,     // -100..100, default 0
    pub whites: f32,      // -100..100, default 0
    pub blacks: f32,      // -100..100, default 0
    pub dehaze: f32,      // -100..100, default 0
}

impl Default for AdjustmentModel {
    fn default() -> Self {
        Self {
            temperature: 6500.0, tint: 0.0,
            exposure: 0.0,
            contrast: 0.0, highlights: 0.0, shadows: 0.0, whites: 0.0, blacks: 0.0,
            dehaze: 0.0,
        }
    }
}

/// Parse an ACR XMP sidecar. Unknown fields are ignored; known fields that
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
        "crs:Dehaze"         => m.dehaze      = v()?,
        "crs:WhiteBalance"   => {
            if let Some((temp, tint)) = wb_preset(value) {
                m.temperature = temp;
                m.tint = tint;
            }
            // Unknown WB names ("As Shot", "Auto", "Custom") leave defaults.
        }
        _ => {}, // Slices 1-2 ignore everything else.
    }
    Ok(())
}

/// Map an ACR `crs:WhiteBalance` preset name to (temperature, tint).
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
    fn parse_baseline_is_defaults() {
        let xml = match load_fixture("test_0002/xmp/baseline.xmp") {
            Some(x) => x, None => return,
        };
        let m = parse(&xml).unwrap();
        // baseline.xmp is defined as ACR defaults — should match Default.
        assert_eq!(m, AdjustmentModel::default());
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
}
