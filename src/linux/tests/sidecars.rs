use std::fs;

use maple_linux::controls::Control;
use maple_linux::sidecar::{sidecar_path, Flag, SidecarDocument, SidecarError, SidecarStore};
use raw_core::types::adjustment::{Profile, WbScaleVersion, WbSource};
use tempfile::TempDir;

fn imported(attributes: &str, children: &str) -> String {
    format!(
        r#"<?xpacket begin="﻿" id="W5M0MpCehiHzreSzNTczkc9d"?>
<x:xmpmeta xmlns:x="adobe:ns:meta/">
  <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
    <rdf:Description rdf:about=""
      xmlns:crs="http://ns.adobe.com/camera-raw-settings/1.0/"
      xmlns:papp="http://ns.justmaple.app/photo/1.0/"
      xmlns:xmp="http://ns.adobe.com/xap/1.0/"
      xmlns:foreign="urn:foreign" {attributes}>
{children}
    </rdf:Description>
  </rdf:RDF>
</x:xmpmeta>
<?xpacket end="w"?>
"#
    )
}

#[test]
fn real_sidecar_round_trip_never_changes_original() {
    let temp = TempDir::new().unwrap();
    let original = temp.path().join("photo.dng");
    fs::write(&original, b"original bytes are immutable").unwrap();
    let (mut store, mut document) = SidecarStore::open(&original).unwrap();
    Control::Exposure.set(&mut document.model, 1.25).unwrap();
    Control::SharpenAmount
        .set(&mut document.model, 0.0)
        .unwrap();
    document.culling.rating = 4;
    document.culling.flag = Flag::Pick;
    store.save(&document).unwrap();
    let (_, loaded) = SidecarStore::open(&original).unwrap();
    assert_eq!(loaded.model.exposure, 1.25);
    assert_eq!(loaded.model.sharpen_amount, 0.0);
    assert_eq!(loaded.culling, document.culling);
    assert_eq!(
        fs::read(&original).unwrap(),
        b"original bytes are immutable"
    );
    assert_eq!(fs::read_dir(temp.path()).unwrap().count(), 2);
    let bytes = fs::read_to_string(store.path()).unwrap();
    assert!(bytes.contains("crs:Version=\"11.0\""));
    assert!(bytes.contains("crs:ProcessVersion=\"11.0\""));
    assert!(bytes.contains("papp:Profile=\"Auto\""));
    assert_eq!(loaded.serialize().unwrap(), bytes);
}

#[test]
fn imported_foreign_attributes_children_and_unexposed_edits_survive() {
    let temp = TempDir::new().unwrap();
    let original = temp.path().join("photo.ARW");
    fs::write(&original, b"original").unwrap();
    let child =
        "      <foreign:node keep='&amp; untouched'><![CDATA[a < b]]><!-- exact --></foreign:node>";
    let source = imported(
        "foreign:attr='&amp; exact' crs:HueAdjustmentRed=\"12\" crs:Version=\"15.3\"",
        child,
    );
    fs::write(original.with_extension("xmp"), &source).unwrap();
    let (mut store, mut document) = SidecarStore::open(&original).unwrap();
    Control::Exposure.set(&mut document.model, 0.5).unwrap();
    store.save(&document).unwrap();
    let written = fs::read_to_string(store.path()).unwrap();
    assert!(written.contains(child));
    assert!(written.contains("foreign:attr='&amp; exact'"));
    assert!(written.contains("crs:HueAdjustmentRed=\"12\""));
    assert!(written.contains("crs:Version=\"15.3\""));
    let reparsed = SidecarDocument::parse(&written).unwrap();
    assert_eq!(reparsed.model.hue_adjustment_red, 12.0);
    assert_eq!(reparsed.serialize().unwrap(), written);
}

#[test]
fn refuses_external_changes_and_deletions() {
    let temp = TempDir::new().unwrap();
    let original = temp.path().join("photo.nef");
    fs::write(&original, b"original").unwrap();
    let (mut store, document) = SidecarStore::open(&original).unwrap();
    fs::write(store.path(), "external edit").unwrap();
    assert!(matches!(store.save(&document), Err(SidecarError::Conflict)));
    assert_eq!(fs::read_to_string(store.path()).unwrap(), "external edit");
    fs::remove_file(store.path()).unwrap();
    store.save(&document).unwrap();
    fs::remove_file(store.path()).unwrap();
    assert!(matches!(store.save(&document), Err(SidecarError::Conflict)));
}

#[test]
fn rejects_malformed_xml_instead_of_overwriting_it() {
    let temp = TempDir::new().unwrap();
    let original = temp.path().join("photo.dng");
    fs::write(&original, b"original").unwrap();
    fs::write(original.with_extension("xmp"), "<broken").unwrap();
    assert!(SidecarStore::open(&original).is_err());
    assert_eq!(
        fs::read_to_string(original.with_extension("xmp")).unwrap(),
        "<broken"
    );
}

#[test]
fn explicit_default_wb_pair_and_version_round_trip() {
    let source = imported(
        "crs:Temperature=\"6500\" crs:Tint=\"0\" papp:WbScaleVersion=\"5\"",
        "",
    );
    let document = SidecarDocument::parse(&source).unwrap();
    let written = document.serialize().unwrap();
    let loaded = SidecarDocument::parse(&written).unwrap();
    assert!(loaded.model.temperature_seen && loaded.model.tint_seen);
    assert_eq!(loaded.model.wb_scale_version, WbScaleVersion::V5);
    assert_eq!(loaded.serialize().unwrap(), written);
}

#[test]
fn manual_wb_clears_sampled_provenance_in_real_file() {
    let temp = TempDir::new().unwrap();
    let original = temp.path().join("photo.dng");
    fs::write(&original, b"original").unwrap();
    let source = imported("crs:WhiteBalance=\"Custom\" papp:WbSource=\"Sampled\" papp:WbSampleX=\"0.25\" papp:WbSampleY=\"0.75\" papp:WbAlgorithmVersion=\"1\"", "");
    fs::write(original.with_extension("xmp"), source).unwrap();
    let (mut store, mut document) = SidecarStore::open(&original).unwrap();
    Control::Tint.set(&mut document.model, 12.0).unwrap();
    store.save(&document).unwrap();
    let written = fs::read_to_string(store.path()).unwrap();
    assert!(!written.contains("WbSample") && !written.contains("WbAlgorithmVersion"));
    let loaded = SidecarDocument::parse(&written).unwrap();
    assert_eq!(loaded.model.wb_source, WbSource::Manual);
    assert_eq!(loaded.model.tint, 12.0);
}

#[test]
fn aliased_namespaces_are_understood_and_preserved() {
    let source = imported("crs:Exposure2012=\"0.75\" papp:Profile=\"Neutral\"", "")
        .replace("crs:", "camera:")
        .replace("xmlns:crs", "xmlns:camera")
        .replace("papp:", "maple:")
        .replace("xmlns:papp", "xmlns:maple");
    let mut document = SidecarDocument::parse(&source).unwrap();
    assert_eq!(document.model.exposure, 0.75);
    assert_eq!(document.model.profile, Profile::Neutral);
    Control::Exposure.set(&mut document.model, 1.0).unwrap();
    let output = document.serialize().unwrap();
    assert!(output.contains("xmlns:camera="));
    let loaded = SidecarDocument::parse(&output).unwrap();
    assert_eq!(loaded.model.exposure, 1.0);
    assert_eq!(loaded.model.profile, Profile::Neutral);
}

#[test]
fn foreign_namespace_cannot_spoof_a_develop_attribute() {
    let source = imported("crs:Exposure2012=\"4\"", "").replace(
        "http://ns.adobe.com/camera-raw-settings/1.0/",
        "urn:foreign-camera",
    );
    let document = SidecarDocument::parse(&source).unwrap();
    assert_eq!(document.model.exposure, 0.0);
    assert!(document.serialize().is_err());
}

#[test]
fn controls_reject_non_finite_values_and_share_core_defaults() {
    let mut document = SidecarDocument::default();
    for control in Control::ALL {
        assert_eq!(control.get(&document.model), control.spec().default_f32);
        assert!(control.set(&mut document.model, f32::NAN).is_err());
        assert!(control
            .set(&mut document.model, control.spec().range.1 + 1.0)
            .is_err());
    }
    document.model.exposure = f32::INFINITY;
    assert!(document.serialize().is_err());
}

#[test]
fn normalized_rounding_omits_near_default_and_handles_negative_ties() {
    let mut document = SidecarDocument::default();
    document.model.exposure = 0.004;
    assert!(!document.serialize().unwrap().contains("Exposure2012"));
    document.model.exposure = -0.125;
    assert!(document
        .serialize()
        .unwrap()
        .contains("crs:Exposure2012=\"-0.12\""));
}

#[test]
fn image_and_live_photo_video_have_distinct_sidecars() {
    assert_eq!(
        sidecar_path(std::path::Path::new("/photos/IMG.DNG")).unwrap(),
        std::path::Path::new("/photos/IMG.xmp")
    );
    assert_eq!(
        sidecar_path(std::path::Path::new("/photos/IMG.MOV")).unwrap(),
        std::path::Path::new("/photos/IMG.MOV.xmp")
    );
    assert!(sidecar_path(std::path::Path::new("/photos/IMG.xmp")).is_err());
}

#[cfg(unix)]
#[test]
fn refuses_symlink_sidecar_without_touching_its_target() {
    let temp = TempDir::new().unwrap();
    let original = temp.path().join("photo.dng");
    fs::write(&original, b"original").unwrap();
    std::os::unix::fs::symlink(&original, original.with_extension("xmp")).unwrap();
    assert!(SidecarStore::open(&original).is_err());
    assert_eq!(fs::read(&original).unwrap(), b"original");
}

#[test]
fn multiple_descriptions_cannot_restore_a_previous_edit() {
    let first = imported("crs:Exposure2012=\"0.5\"", "");
    let source = first.replace("  </rdf:RDF>", "    <rdf:Description xmlns:crs=\"http://ns.adobe.com/camera-raw-settings/1.0/\" xmlns:papp=\"http://ns.justmaple.app/photo/1.0/\" xmlns:foreign=\"urn:foreign\" crs:Exposure2012=\"2\" papp:Look=\"Neutral\" crs:WhiteBalance=\"Daylight\" foreign:second='preserved'/>\n  </rdf:RDF>");
    let mut document = SidecarDocument::parse(&source).unwrap();
    document.model.profile = Profile::Auto;
    Control::Exposure.set(&mut document.model, 0.0).unwrap();
    let written = document.serialize().unwrap();
    let loaded = SidecarDocument::parse(&written).unwrap();
    assert_eq!(loaded.model.exposure, 0.0);
    assert_eq!(loaded.model.profile, Profile::Auto);
    assert!(written.contains("foreign:second='preserved'"));
    assert_eq!(loaded.model.temperature, document.model.temperature);
    assert_eq!(loaded.serialize().unwrap(), written);
}

#[test]
fn nested_foreign_description_is_never_treated_as_the_edit_document() {
    let child = "      <foreign:resource><rdf:Description crs:Exposure2012='7' foreign:key='exact'/></foreign:resource>";
    let source = imported("", child);
    let mut document = SidecarDocument::parse(&source).unwrap();
    assert_eq!(document.model.exposure, 0.0);
    Control::Exposure.set(&mut document.model, 1.0).unwrap();
    let written = document.serialize().unwrap();
    assert!(written.contains(child));
    assert_eq!(
        SidecarDocument::parse(&written).unwrap().model.exposure,
        1.0
    );
}

#[test]
fn point_curves_and_mask_xml_survive_unrelated_edits() {
    let children = "      <papp:SceneLinearToneCurve><rdf:Seq><rdf:li>0, 0</rdf:li><rdf:li>0.5, 0.65</rdf:li><rdf:li>1, 1</rdf:li></rdf:Seq></papp:SceneLinearToneCurve>\n      <foreign:mask attr='verbatim'><foreign:unsupported/></foreign:mask>";
    let source = imported("", children);
    let mut document = SidecarDocument::parse(&source).unwrap();
    let curve = document.model.tone_curve_luma.clone();
    Control::Exposure.set(&mut document.model, 1.0).unwrap();
    let written = document.serialize().unwrap();
    assert!(written.contains(children));
    assert_eq!(
        SidecarDocument::parse(&written)
            .unwrap()
            .model
            .tone_curve_luma,
        curve
    );
}

#[test]
fn repeated_autosaves_keep_the_current_baseline() {
    let temp = TempDir::new().unwrap();
    let original = temp.path().join("photo.dng");
    fs::write(&original, b"original").unwrap();
    let (mut store, mut document) = SidecarStore::open(&original).unwrap();
    for value in [1.0, -0.5, 0.0] {
        Control::Exposure.set(&mut document.model, value).unwrap();
        store.save(&document).unwrap();
        assert_eq!(
            SidecarStore::open(&original).unwrap().1.model.exposure,
            value
        );
    }
    assert_eq!(fs::read(&original).unwrap(), b"original");
}

#[test]
fn legacy_culling_migrates_without_reviving_a_cleared_flag() {
    let mut document = SidecarDocument::parse(&imported("xmp:Label=\"Rejected\"", "")).unwrap();
    assert_eq!(document.culling.flag, Flag::Reject);
    let migrated = document.serialize().unwrap();
    assert!(migrated.contains("papp:Flag=\"reject\""));
    assert!(!migrated.contains("xmp:Label"));
    document.culling.flag = Flag::Unflagged;
    let cleared = document.serialize().unwrap();
    assert_eq!(
        SidecarDocument::parse(&cleared).unwrap().culling.flag,
        Flag::Unflagged
    );
    let document =
        SidecarDocument::parse(&imported("papp:Flag=\"pick\" xmp:Label=\"Rejected\"", "")).unwrap();
    assert_eq!(document.culling.flag, Flag::Pick);
}

#[test]
fn legacy_maple_namespace_is_written_canonically() {
    for old in ["http://ns.justmaple.app/1.0/", "https://maple.app/ns/1.0/"] {
        let source = imported("papp:Profile=\"Neutral\"", "")
            .replace("http://ns.justmaple.app/photo/1.0/", old);
        let document = SidecarDocument::parse(&source).unwrap();
        let output = document.serialize().unwrap();
        assert!(output.contains("xmlns:papp=\"http://ns.justmaple.app/photo/1.0/\""));
        assert_eq!(
            SidecarDocument::parse(&output).unwrap().model.profile,
            Profile::Neutral
        );
    }
}

#[test]
fn real_raw_render_is_identical_after_save_and_reopen() {
    use raw_core::pipeline::{
        render_sized_from_raw_with_quality_and_source, RawInput, RenderQuality,
    };
    let temp = TempDir::new().unwrap();
    let original = temp.path().join("grey.dng");
    let fixture = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../apple/MapleUITests/Fixtures/synthetic/grey-l018-rggb.dng");
    let original_bytes = fs::read(fixture).unwrap();
    fs::write(&original, &original_bytes).unwrap();
    let raw = raw_core::decode::decode(&original).unwrap();
    let (mut store, mut document) = SidecarStore::open(&original).unwrap();
    Control::Temperature
        .set(&mut document.model, 5000.0)
        .unwrap();
    Control::Tint.set(&mut document.model, 12.0).unwrap();
    Control::Exposure.set(&mut document.model, 1.25).unwrap();
    Control::SharpenAmount
        .set(&mut document.model, 0.0)
        .unwrap();
    Control::NrColor.set(&mut document.model, 0.0).unwrap();
    let before = render_sized_from_raw_with_quality_and_source(
        &raw,
        &document.model,
        RenderQuality::Preview,
        Some(RawInput::Path(&original)),
        128,
    )
    .unwrap();
    store.save(&document).unwrap();
    let loaded = SidecarStore::open(&original).unwrap().1;
    let after = render_sized_from_raw_with_quality_and_source(
        &raw,
        &loaded.model,
        RenderQuality::Preview,
        Some(RawInput::Path(&original)),
        128,
    )
    .unwrap();
    assert_eq!(
        before, after,
        "Reopening the real XMP must preserve rendered pixels"
    );
    assert_eq!(fs::read(&original).unwrap(), original_bytes);
}

#[test]
fn film_selection_strength_and_none_round_trip_with_foreign_xml_preserved() {
    let temp = TempDir::new().unwrap();
    let original = temp.path().join("photo.dng");
    fs::write(&original, b"immutable original").unwrap();
    let sidecar = original.with_extension("xmp");
    let imported = imported(
        r#"papp:FilmLook="black_white_agfa_apx_100" papp:FilmStrength="25" foreign:Keep="yes""#,
        "<foreign:Payload>retain verbatim</foreign:Payload>",
    );
    fs::write(&sidecar, imported).unwrap();
    let (mut store, mut document) = SidecarStore::open(&original).unwrap();
    document.model.film_look = "color_negative_agfa_vista_200".into();
    Control::FilmStrength
        .set(&mut document.model, 65.0)
        .unwrap();
    store.save(&document).unwrap();
    let (mut store, mut loaded) = SidecarStore::open(&original).unwrap();
    assert_eq!(loaded.model.film_look, "color_negative_agfa_vista_200");
    assert_eq!(loaded.model.film_strength, 65.0);
    loaded.model.film_look.clear();
    store.save(&loaded).unwrap();
    let (_, off) = SidecarStore::open(&original).unwrap();
    assert!(off.model.film_look.is_empty());
    assert_eq!(off.model.film_strength, 65.0);
    let xml = fs::read_to_string(sidecar).unwrap();
    assert!(!xml.contains("FilmLook="));
    assert!(xml.contains("<foreign:Payload>retain verbatim</foreign:Payload>"));
    assert!(xml.contains("foreign:Keep=\"yes\""));
    assert_eq!(fs::read(original).unwrap(), b"immutable original");
}

#[test]
fn unchanged_foreign_ratings_survive_unrelated_edits() {
    for authored in ["-1", "3.0"] {
        let mut document =
            SidecarDocument::parse(&imported(&format!("xmp:Rating=\"{authored}\""), "")).unwrap();
        Control::Exposure.set(&mut document.model, 0.5).unwrap();
        let saved = document.serialize().unwrap();
        assert!(
            saved.contains(&format!("xmp:Rating=\"{authored}\"")),
            "{authored} was rewritten: {saved}"
        );
        assert_eq!(saved.matches("xmp:Rating").count(), 1);
    }
    let mut document = SidecarDocument::parse(&imported("xmp:Rating=\"3.0\"", "")).unwrap();
    assert_eq!(document.culling.rating, 3);
    document.culling.rating = 5;
    let rated = document.serialize().unwrap();
    assert!(rated.contains("xmp:Rating=\"5\"") && !rated.contains("xmp:Rating=\"3.0\""));
    document.culling.rating = 0;
    assert!(!document.serialize().unwrap().contains("xmp:Rating"));
}
