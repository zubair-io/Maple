use super::*;
use crate::types::accepted_removal::{AcceptedRemoval, NativeWindow, RemovalPlate};
use crate::types::removal_mask::RemovalMask;
use crate::types::BakeGrade;

fn fixture() -> (Removal, Vec<u8>, Vec<u8>) {
    let source = SourceAnchor {
        original: ContentDigest::for_bytes(b"RAW immutable"),
        decode: ContentDigest::for_bytes(b"fixed calibrated scene anchor"),
        width: 8,
        height: 4,
    };
    let patch_window = NativeWindow {
        x: 2,
        y: 1,
        width: 4,
        height: 2,
    };
    let mask = RemovalMask {
        source_width: 8,
        source_height: 4,
        x: 3,
        y: 1,
        width: 2,
        height: 2,
        pixels: vec![255, 0, 255, 255],
    };
    let mask_bytes = super::super::removal_mask_to_bytes(&mask).unwrap();
    let region = patch_window.region(8, 4);
    let patch = InpaintPatch {
        width: 4,
        height: 2,
        origin: [region[0], region[1]],
        extent: [region[2], region[3]],
        pixels: vec![[0.18, -0.125, 8.0]; 8],
        coverage: vec![1.0; 8],
    };
    let patch_bytes = super::super::patch_to_bytes(&patch).unwrap();
    let removal = Removal {
        operation: None,
        accepted: Some(AcceptedRemoval {
            plate: RemovalPlate::PostDcpV1,
            source,
            mask: ContentDigest::for_bytes(&mask_bytes),
            patch_window,
            context_window: NativeWindow {
                x: 0,
                y: 0,
                width: 8,
                height: 4,
            },
            model: ContentDigest::for_bytes(b"model weights"),
            recipe: ContentDigest::for_bytes(b"model photographic recipe"),
            dependencies: vec![],
        }),
        region,
        patch_ref: ContentDigest::for_bytes(&patch_bytes).as_str().into(),
        model_version: "fixture model".into(),
        bake: BakeGrade {
            temperature: 6500.0,
            tint: 0.0,
            exposure: 0.0,
        },
    };
    (removal, mask_bytes, patch_bytes)
}

#[test]
fn real_sidecar_and_both_companions_reopen_without_model_runtime() {
    for plate in [RemovalPlate::PostDcpV1, RemovalPlate::LinearCalibrationV1] {
        let (mut removal, mask, patch) = fixture();
        removal.accepted.as_mut().unwrap().plate = plate;
        let dir = tempfile::tempdir().unwrap();
        let raw = dir.path().join("photo.dng");
        std::fs::write(&raw, b"RAW immutable").unwrap();
        let xml = crate::types::inpaint::encode_removals(std::slice::from_ref(&removal))
            .unwrap()
            .replace('"', "&quot;");
        let xmp = dir.path().join("photo.xmp");
        std::fs::write(&xmp,format!(r#"<rdf:Description xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#" xmlns:papp="http://ns.justmaple.app/photo/1.0/" papp:InpaintRemovals="{xml}"/>"#)).unwrap();
        let store = dir.path().join(".maple/inpaint");
        std::fs::create_dir_all(&store).unwrap();
        let accepted = removal.accepted.as_ref().unwrap();
        let mask_path = store.join(format!("{}.mask", accepted.mask.hex()));
        let patch_path = store.join(format!(
            "{}.f16",
            ContentDigest::parse(&removal.patch_ref).unwrap().hex()
        ));
        std::fs::write(&mask_path, mask).unwrap();
        std::fs::write(&patch_path, patch).unwrap();
        let model = crate::xmp::parse(&std::fs::read_to_string(&xmp).unwrap()).unwrap();
        assert_eq!(model.inpaint_removals, vec![removal.clone()]);
        let resolved = resolve_accepted_removal(
            &model.inpaint_removals[0],
            &accepted.source,
            &std::fs::read(mask_path).unwrap(),
            &std::fs::read(patch_path).unwrap(),
        )
        .unwrap();
        assert_eq!(resolved.width, 4);
        assert_eq!(resolved.pixels[0][2], 8.0);
        assert_eq!(
            ContentDigest::for_bytes(&std::fs::read(raw).unwrap()),
            accepted.source.original
        );
    }
}

#[test]
fn corruption_wrong_source_and_non_native_patch_fail_closed() {
    let (mut removal, mask, patch) = fixture();
    let source = removal.accepted.as_ref().unwrap().source.clone();
    let mut corrupt = patch.clone();
    *corrupt.last_mut().unwrap() ^= 1;
    assert!(resolve_accepted_removal(&removal, &source, &mask, &corrupt).is_err());
    assert!(resolve_accepted_removal(&removal, &source, &[], &patch).is_err());
    let mut changed = source.clone();
    changed.decode = ContentDigest::for_bytes(b"different WB frame");
    assert!(resolve_accepted_removal(&removal, &changed, &mask, &patch).is_err());
    let mut small = super::super::patch_from_bytes(&patch).unwrap();
    small.width = 2;
    small.pixels.truncate(4);
    small.coverage.truncate(4);
    let small = super::super::patch_to_bytes(&small).unwrap();
    removal.patch_ref = ContentDigest::for_bytes(&small).as_str().into();
    assert!(resolve_accepted_removal(&removal, &source, &mask, &small).is_err());
}

#[test]
fn changing_intersecting_dependencies_preserves_pixels_and_marks_review() {
    let (prior, _, _) = fixture();
    let (mut later, _, _) = fixture();
    let accepted = later.accepted.as_mut().unwrap();
    accepted.dependencies =
        removal_context_dependencies(std::slice::from_ref(&prior), accepted).unwrap();
    assert!(!removal_needs_review(&later, std::slice::from_ref(&prior)).unwrap());
    assert!(removal_needs_review(&later, &[]).unwrap());
    let frozen = later.patch_ref.clone();
    let mut changed = prior;
    changed.model_version = "different provenance".into();
    assert!(removal_needs_review(&later, &[changed]).unwrap());
    assert_eq!(later.patch_ref, frozen);
}

#[test]
fn invalid_digest_and_geometry_are_rejected_on_read_and_write() {
    let (mut removal, _, _) = fixture();
    let wire = crate::types::inpaint::encode_removals(std::slice::from_ref(&removal)).unwrap();
    assert!(crate::types::inpaint::decode_removals(&wire.replace("blake3:", "../../:")).is_err());
    assert!(
        crate::types::inpaint::decode_removals(&wire.replace("\"schema\":3", "\"schema\":4"))
            .is_err()
    );
    removal.accepted.as_mut().unwrap().patch_window.width = 3;
    assert!(crate::types::inpaint::encode_removals(&[removal]).is_err());
}

#[test]
fn saved_plate_cannot_be_omitted_downgraded_or_reinterpreted() {
    use crate::types::inpaint::{decode_removals, encode_removals};
    let (mut removal, _, _) = fixture();
    let legacy = encode_removals(std::slice::from_ref(&removal)).unwrap();
    let legacy_value: serde_json::Value = serde_json::from_str(&legacy).unwrap();
    assert_eq!(legacy_value[0]["schema"], 3);
    assert!(legacy_value[0]["accepted"].get("plate").is_none());
    assert_eq!(decode_removals(&legacy).unwrap(), vec![removal.clone()]);
    removal.accepted.as_mut().unwrap().plate = RemovalPlate::LinearCalibrationV1;
    let wire = encode_removals(std::slice::from_ref(&removal)).unwrap();
    let value: serde_json::Value = serde_json::from_str(&wire).unwrap();
    assert_eq!(value[0]["schema"], 4);
    assert_eq!(value[0]["accepted"]["plate"], "linear-calibration-v1");
    assert_eq!(decode_removals(&wire).unwrap(), vec![removal]);
    let mut missing = value.clone();
    missing[0]["accepted"]
        .as_object_mut()
        .unwrap()
        .remove("plate");
    assert!(decode_removals(&missing.to_string()).is_err());
    for wrong in ["post-dcp-v1", "future-plate-v2"] {
        let mut changed = value.clone();
        changed[0]["accepted"]["plate"] = wrong.into();
        assert!(decode_removals(&changed.to_string()).is_err());
    }
    let mut downgraded = value;
    downgraded[0]["schema"] = 3.into();
    assert!(decode_removals(&downgraded.to_string()).is_err());
}
