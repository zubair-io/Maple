use crate::error::{Error, Result};
use quick_xml::events::Event;
use quick_xml::reader::Reader;

/// Slice-1 subset of `AdjustmentModel`. See spec § 01 for the full shape.
#[derive(Clone, Debug, PartialEq)]
pub struct AdjustmentModel {
    pub temperature: f32, // 2000..12000, default 6500
    pub tint: f32,        // -100..100, default 0
    pub exposure: f32,    // -4..+4 EV, default 0
    pub dehaze: f32,      // -100..100, default 0
}

impl Default for AdjustmentModel {
    fn default() -> Self {
        Self { temperature: 6500.0, tint: 0.0, exposure: 0.0, dehaze: 0.0 }
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
        "crs:Dehaze"         => m.dehaze      = v()?,
        _ => {}, // Slice 1 ignores everything else.
    }
    Ok(())
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
    fn parse_wb_daylight() {
        let xml = match load_fixture("test_0002/xmp/wb_daylight.xmp") {
            Some(x) => x, None => return,
        };
        let m = parse(&xml).unwrap();
        // Daylight preset — temp roughly 5500K.
        assert!(m.temperature > 4000.0 && m.temperature < 7000.0,
            "temp was {}", m.temperature);
    }

    #[test]
    fn unknown_fields_are_ignored() {
        let xml = r#"<?xml version="1.0"?><x><rdf:Description xmlns:rdf="x" xmlns:crs="x"
            crs:Exposure2012="1.5" crs:SomeFutureField="99"/></x>"#;
        let m = parse(xml).unwrap();
        assert_eq!(m.exposure, 1.5);
    }
}
