use maple_linux::{
    controls::Control,
    sidecar::{SidecarDocument, SidecarStore},
    white_balance::WhiteBalance,
};
use raw_core::{
    pipeline,
    types::adjustment::{AdjustmentModel, WbScaleVersion},
};
use std::path::PathBuf;

fn source() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../apple/MapleUITests/Fixtures/synthetic/grey-l018-rggb.dng")
}
// Give the real synthetic DNG a non-identity camera calibration. Its committed
// identity matrix intentionally selects raw-core's generic fallback instead.
fn calibrated_dng() -> Vec<u8> {
    let mut bytes = std::fs::read(source()).unwrap();
    assert_eq!(&bytes[..4], b"II*\0");
    let ifd = u32::from_le_bytes(bytes[4..8].try_into().unwrap()) as usize;
    let count = u16::from_le_bytes(bytes[ifd..ifd + 2].try_into().unwrap()) as usize;
    let entry = (0..count)
        .map(|i| ifd + 2 + i * 12)
        .find(|&offset| u16::from_le_bytes(bytes[offset..offset + 2].try_into().unwrap()) == 50721)
        .expect("ColorMatrix1");
    assert_eq!(
        u32::from_le_bytes(bytes[entry + 4..entry + 8].try_into().unwrap()),
        9
    );
    let data = u32::from_le_bytes(bytes[entry + 8..entry + 12].try_into().unwrap()) as usize;
    for (i, numerator) in [6i32, 2, 1, 1, 8, 1, 1, 1, 8].into_iter().enumerate() {
        bytes[data + i * 8..data + i * 8 + 4].copy_from_slice(&numerator.to_le_bytes());
        bytes[data + i * 8 + 4..data + i * 8 + 8].copy_from_slice(&10i32.to_le_bytes());
    }
    bytes
}
fn pixels(raw: &raw_core::RawImage, model: &AdjustmentModel) -> Vec<u8> {
    pipeline::render_sized_from_raw_with_quality_and_source(
        raw,
        model,
        pipeline::RenderQuality::Preview,
        None,
        256,
    )
    .unwrap()
    .2
}

#[test]
fn as_shot_identity_edit_round_trips_without_changing_pixels_or_original() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("photo.dng");
    let original = calibrated_dng();
    std::fs::write(&path, &original).unwrap();
    let raw = raw_core::decode::decode(&path).unwrap();
    let reference = WhiteBalance::from_raw(&raw).unwrap();
    assert!(
        matches!(reference, WhiteBalance::Camera(_)),
        "fixture must qualify camera WB"
    );
    let (mut store, mut document) = SidecarStore::open(&path).unwrap();
    let untouched = document.serialize().unwrap();
    let before = pixels(&raw, &document.model);
    let (temperature, tint) = reference.values(&document.model);
    assert!(temperature.is_finite() && tint.is_finite());
    assert_eq!(document.serialize().unwrap(), untouched);
    assert!(!path.with_extension("xmp").exists());
    reference
        .edit(&mut document.model, Control::Temperature, temperature)
        .unwrap();
    assert_eq!(document.model.tint, tint);
    assert_eq!(document.model.wb_scale_version, WbScaleVersion::V5);
    store.save(&document).unwrap();
    let reopened = SidecarStore::open(&path).unwrap().1;
    assert!(reopened.model.temperature_seen && reopened.model.tint_seen);
    assert_eq!(before, pixels(&raw, &reopened.model));
    assert_eq!(std::fs::read(path).unwrap(), original);
}

#[test]
fn legacy_wb_edit_keeps_the_other_effective_component_and_unknown_xml() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("photo.dng");
    std::fs::write(&path, calibrated_dng()).unwrap();
    let xml = r#"<x:xmpmeta xmlns:x="adobe:ns:meta/">
<rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
<rdf:Description xmlns:crs="http://ns.adobe.com/camera-raw-settings/1.0/"
xmlns:papp="http://ns.justmaple.app/photo/1.0/" xmlns:vendor="urn:camera:private"
crs:WhiteBalance="Custom" crs:Temperature="6000" crs:Tint="20"
papp:WbScaleVersion="1" vendor:Private="retain-me"/>
</rdf:RDF></x:xmpmeta>"#;
    std::fs::write(path.with_extension("xmp"), xml).unwrap();
    let raw = raw_core::decode::decode(&path).unwrap();
    let reference = WhiteBalance::from_raw(&raw).unwrap();
    let (mut store, mut document) = SidecarStore::open(&path).unwrap();
    assert_eq!(document.model.wb_scale_version, WbScaleVersion::V1);
    let (temperature, tint) = reference.values(&document.model);
    reference
        .edit(
            &mut document.model,
            Control::Temperature,
            temperature + 50.0,
        )
        .unwrap();
    assert_eq!(document.model.tint, tint);
    store.save(&document).unwrap();
    let saved_xml = std::fs::read_to_string(path.with_extension("xmp")).unwrap();
    assert!(saved_xml.contains("vendor:Private=\"retain-me\""));
    let reopened = SidecarDocument::parse(&saved_xml).unwrap();
    assert_eq!(reopened.model.wb_scale_version, WbScaleVersion::V5);
    assert!((reopened.model.temperature - temperature - 50.0).abs() < 0.01);
    assert!((reopened.model.tint - tint).abs() < 0.01);
    assert_eq!(pixels(&raw, &document.model), pixels(&raw, &reopened.model));
}

#[test]
fn rejected_edit_does_not_author_or_mutate_white_balance() {
    let raw = raw_core::decode::decode(&source()).unwrap();
    let reference = WhiteBalance::from_raw(&raw).unwrap();
    let mut document = SidecarDocument::default();
    let before = document.serialize().unwrap();
    assert!(reference
        .edit(&mut document.model, Control::Temperature, f32::NAN)
        .is_err());
    assert!(reference
        .edit(&mut document.model, Control::Exposure, 1.0)
        .is_err());
    assert_eq!(document.serialize().unwrap(), before);
}

#[test]
fn display_fallback_preserves_the_unauthored_half_and_converts_legacy_tint() {
    let reference = WhiteBalance::Display;
    let mut model = AdjustmentModel {
        temperature: 5000.0,
        temperature_seen: true,
        tint: 40.0,
        tint_seen: false,
        wb_scale_version: WbScaleVersion::V2,
        ..Default::default()
    };
    assert_eq!(reference.values(&model), (5000.0, 0.0));
    reference
        .edit(&mut model, Control::Temperature, 5500.0)
        .unwrap();
    assert_eq!(model.tint, 0.0);
    model.tint = 40.0;
    model.wb_scale_version = WbScaleVersion::V2;
    let effective = raw_core::stages::white_balance::resolve_wb(&model);
    reference
        .edit(&mut model, Control::Temperature, 5600.0)
        .unwrap();
    assert_eq!(model.tint, effective.1);
    assert_eq!(model.wb_scale_version, WbScaleVersion::V5);
}
