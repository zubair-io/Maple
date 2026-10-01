use super::*;
use crate::{
    pipeline::{
        patch_to_bytes, prepare_accepted_removal, removal_asset_names, removal_mask_to_bytes,
        render_removal_calibration_plate,
    },
    types::{accepted_removal::NativeWindow, inpaint::decode_removals, removal_mask::RemovalMask},
};

pub(super) const RAW: &[u8] =
    include_bytes!("../../../../../test-fixtures/removal/basic/source.dng");

pub(super) fn fixture() -> (
    RawImage,
    ContentDigest,
    AdjustmentModel,
    BTreeMap<String, Vec<u8>>,
) {
    let raw = crate::decode_raw(RAW, "dng").unwrap();
    let original = ContentDigest::for_bytes(RAW);
    let source = super::super::removal_calibration_source_anchor(&raw, &original).unwrap();
    let plate = render_removal_calibration_plate(&raw, CancelToken::never()).unwrap();
    let window = NativeWindow {
        x: 0,
        y: 0,
        width: plate.width,
        height: plate.height,
    };
    let mut records = "[]".to_owned();
    let mut assets = BTreeMap::new();
    for x in [3, 5] {
        let mask = removal_mask_to_bytes(&RemovalMask {
            source_width: plate.width,
            source_height: plate.height,
            x,
            y: 2,
            width: 1,
            height: 1,
            pixels: vec![255],
        })
        .unwrap();
        let selected = (2 * plate.width + x) as usize;
        let mut coverage = vec![0.0; plate.pixels.len()];
        coverage[selected] = 1.0;
        let patch = patch_to_bytes(&InpaintPatch {
            width: plate.width,
            height: plate.height,
            origin: [0.0; 2],
            extent: [1.0; 2],
            pixels: plate.pixels.iter().map(|p| p.map(|v| v * 0.5)).collect(),
            coverage,
        })
        .unwrap();
        let request = serde_json::json!({
            "plate":"linear-calibration-v1", "source":source,
            "patch_window":window, "context_window":window,
            "model":ContentDigest::for_bytes(b"fixed weights"),
            "recipe":ContentDigest::for_bytes(b"fixed photographic recipe"),
            "model_version":"photographic fixture", "bake":{"temp":6500,"tint":0,"ev":0},
        });
        records = prepare_accepted_removal(&request.to_string(), &records, &mask, &patch).unwrap();
        assets.insert(
            format!("{}.mask", ContentDigest::for_bytes(&mask).hex()),
            mask,
        );
        assets.insert(
            format!("{}.f16", ContentDigest::for_bytes(&patch).hex()),
            patch,
        );
    }
    let model = AdjustmentModel {
        inpaint_removals: decode_removals(&records).unwrap(),
        ..super::super::removal_context::anchor_model()
    };
    (raw, original, model, assets)
}

#[test]
fn generation_context_sees_saved_pixels_and_refuses_a_changed_stack() {
    let (raw, original, model, assets) = fixture();
    let stack =
        ResolvedCalibrationRemovals::prepare(&raw, &original, &model.inpaint_removals, &assets)
            .unwrap();
    let window = NativeWindow {
        x: 2,
        y: 1,
        width: 6,
        height: 4,
    };
    let context = stack
        .generation_context(&raw, &original, &model, window, CancelToken::never())
        .unwrap();
    let plain =
        super::super::render_removal_calibration_context(&raw, window, CancelToken::never())
            .unwrap();
    assert_eq!(context.pixels[0], plain.pixels[0]);
    for (record, x) in model.inpaint_removals.iter().zip([3, 5]) {
        let name = format!(
            "{}.f16",
            ContentDigest::parse(&record.patch_ref).unwrap().hex()
        );
        let patch = super::super::patch_from_bytes(&assets[&name]).unwrap();
        let index = (window.width + x - window.x) as usize;
        assert_eq!(
            context.pixels[index],
            patch.pixels[(2 * patch.width + x) as usize]
        );
        assert_ne!(context.pixels[index], plain.pixels[index]);
    }
    let mut changed = model.clone();
    changed.inpaint_removals.pop();
    assert!(stack
        .generation_context(&raw, &original, &changed, window, CancelToken::never())
        .is_err());
    let flag = std::sync::atomic::AtomicBool::new(true);
    assert!(matches!(
        stack.generation_context(&raw, &original, &model, window, CancelToken::new(&flag)),
        Err(crate::Error::Cancelled)
    ));
}

#[test]
fn saved_stack_reopens_from_real_sidecar_and_companions_without_inference() {
    let (raw, original, model, assets) = fixture();
    let dir = tempfile::tempdir().unwrap();
    let source_path = dir.path().join("photo.dng");
    std::fs::write(&source_path, RAW).unwrap();
    let wire = crate::types::inpaint::encode_removals(&model.inpaint_removals).unwrap();
    let xml = format!(
        r#"<rdf:Description xmlns:rdf="x" xmlns:papp="http://ns.justmaple.app/photo/1.0/" papp:InpaintRemovals="{}"/>"#,
        wire.replace('"', "&quot;")
    );
    let sidecar = dir.path().join("photo.xmp");
    std::fs::write(&sidecar, xml).unwrap();
    let companion_dir = dir.path().join(".maple/inpaint");
    std::fs::create_dir_all(&companion_dir).unwrap();
    for (name, bytes) in &assets {
        std::fs::write(companion_dir.join(name), bytes).unwrap();
    }
    let mut opened = crate::xmp::parse(&std::fs::read_to_string(sidecar).unwrap()).unwrap();
    // The fixture's fixed upstream recipe is independent of the saved WB/grade.
    opened.lens_profile_enable = model.lens_profile_enable;
    opened.nr_color = 0.0;
    opened.sharpen_amount = 0.0;
    opened.auto_exposure = crate::xmp::AutoExposureMode::Off;
    let read_assets = removal_asset_names(&wire)
        .unwrap()
        .into_iter()
        .map(|name| {
            (
                name.clone(),
                std::fs::read(companion_dir.join(name)).unwrap(),
            )
        })
        .collect();
    let stack = ResolvedCalibrationRemovals::prepare(
        &raw,
        &original,
        &opened.inpaint_removals,
        &read_assets,
    )
    .unwrap();
    assert!(stack.needs_review().is_empty());
    let original_samples = raw.raw_data.clone();
    for (temperature, exposure) in [(6500.0, 0.0), (4300.0, 2.0), (9000.0, -3.0)] {
        let grade = AdjustmentModel {
            temperature,
            temperature_seen: true,
            exposure,
            ..opened.clone()
        };
        let actual = stack
            .develop(&raw, &original, &grade, CancelToken::never())
            .unwrap();
        let expected = super::super::develop_removal_calibration_patches(
            &raw,
            &grade,
            &stack.patches,
            CancelToken::never(),
        )
        .unwrap();
        assert_eq!(actual.pixels, expected.pixels);
        assert_eq!(actual.whites_anchor_ev, expected.whites_anchor_ev);
    }
    assert_eq!(raw.raw_data, original_samples);
    assert_eq!(
        ContentDigest::for_bytes(&std::fs::read(source_path).unwrap()),
        original
    );
}

#[test]
fn changed_source_or_stack_cannot_reuse_an_old_preparation() {
    let (raw, original, mut model, assets) = fixture();
    let stack =
        ResolvedCalibrationRemovals::prepare(&raw, &original, &model.inpaint_removals, &assets)
            .unwrap();
    let other = ContentDigest::for_bytes(b"different RAW bytes");
    assert!(stack
        .develop(&raw, &other, &model, CancelToken::never())
        .is_err());
    model.inpaint_removals.reverse();
    assert!(stack
        .develop(&raw, &original, &model, CancelToken::never())
        .is_err());
    model.inpaint_removals.clear();
    assert!(stack
        .develop(&raw, &original, &model, CancelToken::never())
        .is_err());
}

#[test]
fn missing_corrupt_or_wrong_plate_later_edit_rejects_the_whole_stack() {
    let (raw, original, mut model, mut assets) = fixture();
    let patch = format!(
        "{}.f16",
        ContentDigest::parse(&model.inpaint_removals[1].patch_ref)
            .unwrap()
            .hex()
    );
    let bytes = assets.remove(&patch).unwrap();
    let error = match ResolvedCalibrationRemovals::prepare(
        &raw,
        &original,
        &model.inpaint_removals,
        &assets,
    ) {
        Ok(_) => panic!("missing later edit produced a partial stack"),
        Err(error) => error,
    };
    assert!(error.contains("missing companion"));
    assets.insert(patch.clone(), b"corrupt".to_vec());
    assert!(ResolvedCalibrationRemovals::prepare(
        &raw,
        &original,
        &model.inpaint_removals,
        &assets
    )
    .is_err());
    assets.insert(patch, bytes);
    model.inpaint_removals[1].accepted.as_mut().unwrap().plate = RemovalPlate::PostDcpV1;
    assert!(ResolvedCalibrationRemovals::prepare(
        &raw,
        &original,
        &model.inpaint_removals,
        &assets
    )
    .is_err());
}

#[test]
fn changed_dependencies_require_review_and_retain_accepted_pixels() {
    let (raw, original, mut model, assets) = fixture();
    model.inpaint_removals.remove(0);
    let stack =
        ResolvedCalibrationRemovals::prepare(&raw, &original, &model.inpaint_removals, &assets)
            .unwrap();
    assert_eq!(stack.needs_review(), [0]);
    assert_eq!(stack.patches.len(), 1);
    assert!(stack
        .develop(&raw, &original, &model, CancelToken::never())
        .is_ok());
}
