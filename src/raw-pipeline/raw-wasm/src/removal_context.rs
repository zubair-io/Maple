//! Bounded fixed calibration context shared by CPU and WebGPU RAW sessions (#3955).
use raw_core::{cancel::CancelToken, image::RawImage, types::accepted_removal::NativeWindow};

pub(crate) fn source(
    raw: &RawImage,
    original: &raw_core::types::accepted_removal::ContentDigest,
) -> Result<String, String> {
    raw_core::pipeline::removal_calibration_source_anchor(raw, original)
        .map_err(|e| e.to_string())
        .and_then(|source| serde_json::to_string(&source).map_err(|e| e.to_string()))
}

pub(crate) fn map_points(raw: &RawImage, xmp: &str, request: &str) -> Result<String, String> {
    let model = raw_core::xmp::parse(xmp).map_err(|e| e.to_string())?;
    raw_core::pipeline::map_removal_display_points(raw, &model, request)
}

/// Interleaved native f32 RGB in un-oriented DefaultCrop coordinates. Invoked
/// once per generation context, never by the slider render path. The current
/// fixed upstream policy remains an experiment, separate from saved rendering.
pub(crate) fn prepare(raw: &RawImage, rect: &[u32]) -> Result<Vec<f32>, String> {
    let [x, y, width, height] = rect else {
        return Err("removal context requires x,y,width,height".into());
    };
    let image = raw_core::pipeline::render_removal_calibration_context(
        raw,
        NativeWindow {
            x: *x,
            y: *y,
            width: *width,
            height: *height,
        },
        CancelToken::never(),
    )
    .map_err(|error| error.to_string())?;
    Ok(image.pixels.into_iter().flatten().collect())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn retained_mapping_matches_core_and_preserves_unmapped_gesture_positions() {
        let bytes = include_bytes!("../../../../test-fixtures/removal/basic/source.dng");
        let session = crate::native_detail::NativeDetailSession::new(bytes, "dng").unwrap();
        let xmp = r#"<rdf:Description xmlns:rdf="x" xmlns:crs="http://ns.adobe.com/camera-raw-settings/1.0/" crs:PerspectiveX="100"/>"#;
        let request = r#"{"schema":1,"points":[[0.0,0.5],[0.8,0.5],[1.1,0.5]]}"#;
        let raw = raw_core::decode_raw(bytes, "dng").unwrap();
        let model = raw_core::xmp::parse(xmp).unwrap();
        let expected =
            raw_core::pipeline::map_removal_display_points(&raw, &model, request).unwrap();
        let mapped = session.removal_map_points(xmp, request).unwrap();
        assert_eq!(mapped, expected);
        let value: serde_json::Value = serde_json::from_str(&mapped).unwrap();
        assert_eq!(value["source_size"], serde_json::json!([16, 8]));
        assert_eq!(value["points"][0], serde_json::Value::Null);
        assert_eq!(value["points"][2], serde_json::Value::Null);
        assert!((value["points"][1][0].as_f64().unwrap() - 0.3).abs() < 1e-7);
        // Test the fallible shared boundary directly on native: constructing a
        // JsError is a wasm-bindgen browser operation, not a native Rust one.
        assert!(map_points(&raw, xmp, r#"{"schema":2,"points":[]}"#).is_err());
        assert!(map_points(&raw, xmp, r#"{"schema":1,"points":[],"extra":0}"#).is_err());
        let cropped = r#"<rdf:Description xmlns:rdf="x" xmlns:crs="http://ns.adobe.com/camera-raw-settings/1.0/" crs:HasCrop="True" crs:CropLeft="0.25" crs:CropRight="0.75" crs:CropTop="0" crs:CropBottom="1" crs:CropAngle="90"/>"#;
        let request = r#"{"schema":1,"crop_input_size":[16,8],"points":[[0.5,0.25]]}"#;
        let mapped: serde_json::Value =
            serde_json::from_str(&session.removal_map_points(cropped, request).unwrap()).unwrap();
        assert_eq!(mapped["points"], serde_json::json!([[0.375, 0.5]]));
        assert!(map_points(
            &raw,
            cropped,
            r#"{"schema":1,"crop_input_size":[0,8],"points":[]}"#
        )
        .is_err());
    }

    #[test]
    fn retained_context_is_shared_native_rgb_and_geometry_errors_are_explicit() {
        let bytes = include_bytes!("../../../../test-fixtures/removal/basic/source.dng");
        let raw = raw_core::decode_raw(bytes, "dng").unwrap();
        let original = raw_core::types::accepted_removal::ContentDigest::for_bytes(bytes);
        let anchor: raw_core::types::accepted_removal::SourceAnchor =
            serde_json::from_str(&source(&raw, &original).unwrap()).unwrap();
        assert_eq!(
            anchor,
            raw_core::pipeline::removal_calibration_source_anchor(&raw, &original).unwrap()
        );
        let window = NativeWindow {
            x: 1,
            y: 1,
            width: 7,
            height: 5,
        };
        let expected = raw_core::pipeline::render_removal_calibration_context(
            &raw,
            window,
            CancelToken::never(),
        )
        .unwrap();
        let values = prepare(&raw, &[1, 1, 7, 5]).unwrap();
        assert_eq!(
            values,
            expected.pixels.into_iter().flatten().collect::<Vec<_>>()
        );
        assert_eq!(values.len(), 7 * 5 * 3);
        assert!(prepare(&raw, &[1, 2, 3]).is_err());
        assert!(prepare(&raw, &[u32::MAX, 0, 7, 5]).is_err());
        assert!(prepare(&raw, &[0, 0, 1025, 1]).is_err());
    }
}
