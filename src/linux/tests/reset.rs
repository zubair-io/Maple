use maple_linux::sidecar::{SidecarDocument, SidecarStore};
use raw_core::types::adjustment::Profile;

#[test]
fn reset_round_trips_global_controls_without_losing_geometry_culling_or_unknown_xml() {
    let directory = tempfile::tempdir().unwrap();
    let original = directory.path().join("photo.dng");
    let bytes = include_bytes!("../../apple/MapleUITests/Fixtures/synthetic/grey-l018-rggb.dng");
    std::fs::write(&original, bytes).unwrap();
    let xml = r#"<x:xmpmeta xmlns:x="adobe:ns:meta/">
<rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
<rdf:Description xmlns:crs="http://ns.adobe.com/camera-raw-settings/1.0/"
xmlns:papp="http://ns.justmaple.app/photo/1.0/" xmlns:xmp="http://ns.adobe.com/xap/1.0/"
xmlns:vendor="urn:private" crs:Exposure2012="2" crs:Temperature="5000" crs:Tint="20"
crs:WhiteBalance="Custom" papp:WbSource="Sampled" papp:WbSampleX="0.4"
papp:WbSampleY="0.5" papp:WbAlgorithmVersion="1" papp:Profile="Neutral"
crs:HueAdjustmentRed="30" crs:HasCrop="True" crs:CropTop="0.1" crs:CropBottom="0.9"
crs:CropLeft="0.2" crs:CropRight="0.8" crs:CropAngle="5" crs:PerspectiveRotate="2"
xmp:Rating="4" papp:Flag="pick" vendor:Data="exact">
<crs:ToneCurvePV2012><rdf:Seq><rdf:li>0, 0</rdf:li><rdf:li>128, 180</rdf:li><rdf:li>255, 255</rdf:li></rdf:Seq></crs:ToneCurvePV2012>
<vendor:Nested><vendor:Item value="keep">untouched</vendor:Item></vendor:Nested>
</rdf:Description></rdf:RDF></x:xmpmeta>"#;
    std::fs::write(original.with_extension("xmp"), xml).unwrap();
    let (mut store, mut document) = SidecarStore::open(&original).unwrap();
    let crop = document.model.crop;
    let culling = document.culling.clone();
    let rotation = document.model.perspective_rotate;
    let before = document.clone();
    document.reset_develop().unwrap();
    assert_eq!(document.model.exposure, 0.0);
    assert_eq!(document.model.profile, Profile::Auto);
    assert!(!document.model.temperature_seen && !document.model.tint_seen);
    assert_eq!(document.model.hue_adjustment_red, 0.0);
    assert_eq!(document.model.crop, crop);
    assert_eq!(document.model.perspective_rotate, rotation);
    assert_eq!(document.culling, culling);
    store.save(&document).unwrap();
    let saved = std::fs::read_to_string(original.with_extension("xmp")).unwrap();
    assert!(saved.contains("vendor:Data=\"exact\""));
    assert!(saved.contains(
        "<vendor:Nested><vendor:Item value=\"keep\">untouched</vendor:Item></vendor:Nested>"
    ));
    assert!(!saved.contains("ToneCurvePV2012"));
    assert!(!saved.contains("WbSampleX"));
    let reopened = SidecarDocument::parse(&saved).unwrap();
    assert_eq!(reopened.model.exposure, 0.0);
    assert_eq!(reopened.model.crop, crop);
    assert_eq!(reopened.model.profile, Profile::Auto);
    assert_eq!(reopened.culling, culling);
    // Undo's original document restores imported settings and XML after a reset save.
    store.save(&before).unwrap();
    let restored = SidecarStore::open(&original).unwrap().1;
    assert_eq!(restored.model.exposure, 2.0);
    assert_eq!(restored.model.hue_adjustment_red, 30.0);
    assert_eq!(restored.model.profile, Profile::Neutral);
    assert_eq!(std::fs::read(original).unwrap(), bytes);
}
