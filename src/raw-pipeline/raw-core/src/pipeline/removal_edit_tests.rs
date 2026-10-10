use super::*;
use crate::{cancel::CancelToken, pipeline::ResolvedCalibrationRemovals};
use std::collections::BTreeMap;
const RECORDS: &str = include_str!("../../../../../test-fixtures/removal/calibration/records.txt");
const RAW: &[u8] = include_bytes!("../../../../../test-fixtures/removal/calibration/source.dng");
const MASK: &[u8] = include_bytes!("../../../../../test-fixtures/removal/calibration/mask.mimf");
const PATCH: &[u8] = include_bytes!("../../../../../test-fixtures/removal/calibration/patch.f16");
const REQUEST: &str = include_str!("../../../../../test-fixtures/removal/calibration/request.txt");

fn entries(records: &str) -> Vec<Value> {
    serde_json::from_str(&saved_removal_list(records).unwrap()).unwrap()
}
fn edit(
    records: &str,
    id: &Value,
    action: &str,
    active: Option<bool>,
    replacement: Option<&str>,
) -> Result<String, String> {
    let request = serde_json::json!({"schema":1,"id":id,"action":action,"active":active,"replacement":replacement});
    edit_saved_removal(records, &request.to_string())
}
fn fixture() -> (String, BTreeMap<String, Vec<u8>>) {
    let mut patch = crate::pipeline::patch_from_bytes(PATCH).unwrap();
    for pixel in &mut patch.pixels {
        *pixel = pixel.map(|v| v * 2.0);
    }
    let later_patch = crate::pipeline::patch_to_bytes(&patch).unwrap();
    let stack =
        crate::pipeline::prepare_accepted_removal(REQUEST, RECORDS, MASK, &later_patch).unwrap();
    let bytes = [MASK, PATCH, &later_patch];
    let mut assets = BTreeMap::new();
    for name in crate::pipeline::removal_asset_names(&stack).unwrap() {
        let blob = bytes
            .iter()
            .find(|bytes| name.starts_with(ContentDigest::for_bytes(bytes).hex()))
            .unwrap();
        assets.insert(name, blob.to_vec());
    }
    (stack, assets)
}

#[test]
fn toggle_upgrade_retains_identity_pixels_dependencies_and_unknown_records() {
    let (stack, _) = fixture();
    let mut raw: Vec<Value> = serde_json::from_str(&stack).unwrap();
    raw.insert(
        1,
        serde_json::json!({"kind":"foreign-future-operation","metadata":{"text":"preserve me"}}),
    );
    let wire = serde_json::to_string(&raw).unwrap();
    let listed = entries(&wire);
    assert!(listed
        .iter()
        .all(|entry| entry["active"] == true && entry["needs_review"] == false));
    assert_eq!(raw[0]["schema"], 4);
    let original_digest =
        crate::pipeline::removal_record_digest(&decode_removals(&wire).unwrap()[0]).unwrap();
    let disabled = edit(&wire, &listed[0]["id"], "set-active", Some(false), None).unwrap();
    let values: Vec<Value> = serde_json::from_str(&disabled).unwrap();
    assert_eq!(values[1], raw[1]);
    assert_eq!(values[0]["schema"], 5);
    assert_eq!(values[2]["schema"], 5);
    assert_eq!(values[0]["patch"], raw[0]["patch"]);
    assert_eq!(values[2]["accepted"], raw[2]["accepted"]);
    assert_eq!(entries(&disabled)[1]["needs_review"], true);
    assert_eq!(
        crate::pipeline::removal_record_digest(&decode_removals(&disabled).unwrap()[0]).unwrap(),
        original_digest
    );
    let enabled = edit(&disabled, &listed[0]["id"], "set-active", Some(true), None).unwrap();
    assert_eq!(entries(&enabled)[1]["needs_review"], false);
    assert_eq!(
        entries(&enabled)
            .iter()
            .map(|e| &e["id"])
            .collect::<Vec<_>>(),
        listed.iter().map(|e| &e["id"]).collect::<Vec<_>>()
    );
}

#[test]
fn deletion_keeps_the_later_identity_baked_assets_and_review_status() {
    let (wire, _) = fixture();
    let rows = entries(&wire);
    let deleted = edit(&wire, &rows[0]["id"], "delete", None, None).unwrap();
    let remaining = entries(&deleted);
    assert_eq!(remaining.len(), 1);
    assert_eq!(remaining[0]["id"], rows[1]["id"]);
    assert_eq!(remaining[0]["needs_review"], true);
    let before = decode_removals(&wire).unwrap();
    let after = decode_removals(&deleted).unwrap();
    assert_eq!(before[1].patch_ref, after[0].patch_ref);
    assert_eq!(before[1].accepted, after[0].accepted);
    assert!(edit(&deleted, &rows[0]["id"], "delete", None, None).is_err());
}

#[test]
fn replacement_preserves_order_identity_and_freezes_later_pixels() {
    let (wire, _) = fixture();
    let rows = entries(&wire);
    let prefix = saved_removal_prefix(&wire, rows[0]["id"].as_str().unwrap()).unwrap();
    assert_eq!(prefix, "[]");
    let mut request: Value = serde_json::from_str(REQUEST).unwrap();
    request["model_version"] = "replacement recipe".into();
    let candidate =
        crate::pipeline::prepare_accepted_removal(&request.to_string(), &prefix, MASK, PATCH)
            .unwrap();
    let replaced = edit(&wire, &rows[0]["id"], "replace", None, Some(&candidate)).unwrap();
    let accepted = entries(&replaced);
    assert_eq!(accepted[0]["id"], rows[0]["id"]);
    assert_eq!(accepted[1]["id"], rows[1]["id"]);
    assert_eq!(accepted[0]["needs_review"], false);
    assert_eq!(accepted[1]["needs_review"], true);
    assert_eq!(
        decode_removals(&replaced).unwrap()[1].accepted,
        decode_removals(&wire).unwrap()[1].accepted
    );
    let prefix = saved_removal_prefix(&replaced, rows[1]["id"].as_str().unwrap()).unwrap();
    assert_eq!(decode_removals(&prefix).unwrap().len(), 1);
    assert!(edit(&replaced, &rows[1]["id"], "replace", None, Some(&candidate)).is_err());
    let correct = crate::pipeline::prepare_accepted_removal(REQUEST, &prefix, MASK, PATCH).unwrap();
    let renewed = edit(&replaced, &rows[1]["id"], "replace", None, Some(&correct)).unwrap();
    assert_eq!(entries(&renewed)[1]["needs_review"], false);
}

#[test]
fn disabled_records_reopen_and_render_without_inference_or_entering_generation_context() {
    let (wire, assets) = fixture();
    let rows = entries(&wire);
    let first = edit(&wire, &rows[0]["id"], "set-active", Some(false), None).unwrap();
    let all = edit(&first, &rows[1]["id"], "set-active", Some(false), None).unwrap();
    let folder = tempfile::tempdir().unwrap();
    std::fs::write(folder.path().join("photo.dng"), RAW).unwrap();
    let companion = folder.path().join(".maple/inpaint");
    std::fs::create_dir_all(&companion).unwrap();
    for (name, bytes) in &assets {
        std::fs::write(companion.join(name), bytes).unwrap();
    }
    for records in [&wire, &first, &all] {
        let xml = format!(
            r#"<rdf:Description xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#" xmlns:papp="http://ns.justmaple.app/photo/1.0/" papp:InpaintRemovals="{}"/>"#,
            records.replace('"', "&quot;")
        );
        std::fs::write(folder.path().join("photo.xmp"), xml).unwrap();
        let mut model =
            crate::xmp::parse(&std::fs::read_to_string(folder.path().join("photo.xmp")).unwrap())
                .unwrap();
        model.auto_exposure = crate::xmp::AutoExposureMode::Off;
        model.sharpen_amount = 0.0;
        model.nr_color = 0.0;
        let raw = crate::decode_raw(RAW, "dng").unwrap();
        let original = ContentDigest::for_bytes(RAW);
        let files = crate::pipeline::removal_asset_names(records)
            .unwrap()
            .into_iter()
            .map(|name| {
                let bytes = std::fs::read(companion.join(&name)).unwrap();
                (name, bytes)
            })
            .collect();
        let prepared =
            ResolvedCalibrationRemovals::prepare(&raw, &original, &model.inpaint_removals, &files)
                .unwrap();
        let active_patches: Vec<_> = model
            .inpaint_removals
            .iter()
            .filter(|record| record.is_active())
            .map(|record| {
                crate::pipeline::patch_from_bytes(
                    &assets[&format!(
                        "{}.f16",
                        ContentDigest::parse(&record.patch_ref).unwrap().hex()
                    )],
                )
                .unwrap()
            })
            .collect();
        let actual = prepared
            .develop(&raw, &original, &model, CancelToken::never())
            .unwrap();
        let oracle = crate::pipeline::develop_removal_calibration_patches(
            &raw,
            &model,
            &active_patches,
            CancelToken::never(),
        )
        .unwrap();
        assert_eq!(actual.pixels, oracle.pixels);
        let source = &model.inpaint_removals[0].accepted.as_ref().unwrap().source;
        let full = crate::types::accepted_removal::NativeWindow {
            x: 0,
            y: 0,
            width: source.width,
            height: source.height,
        };
        let context = prepared
            .generation_context(&raw, &original, &model, full, CancelToken::never())
            .unwrap();
        let mut expected =
            crate::pipeline::render_removal_calibration_context(&raw, full, CancelToken::never())
                .unwrap();
        crate::stages::inpaint_composite::apply_window(
            &mut expected,
            &active_patches,
            [0.0, 0.0, 1.0, 1.0],
        )
        .unwrap();
        assert_eq!(context.pixels, expected.pixels);
        assert_eq!(std::fs::read(folder.path().join("photo.dng")).unwrap(), RAW);
    }
    assert_eq!(std::fs::read_dir(companion).unwrap().count(), assets.len());
}

#[test]
fn malformed_control_versions_and_duplicate_identities_fail_closed() {
    let rows = entries(RECORDS);
    let valid = edit(RECORDS, &rows[0]["id"], "set-active", Some(false), None).unwrap();
    let mut values: Vec<Value> = serde_json::from_str(&valid).unwrap();
    assert_eq!(
        crate::types::inpaint::encode_removals(&decode_removals(&valid).unwrap()).unwrap(),
        valid
    );
    for bad in [
        serde_json::json!("false"),
        Value::Null,
        serde_json::json!(0),
    ] {
        values[0]["active"] = bad;
        assert!(decode_removals(&serde_json::to_string(&values).unwrap()).is_err());
    }
    let value: Vec<Value> = serde_json::from_str(&valid).unwrap();
    assert!(decode_removals(
        &serde_json::to_string(&vec![value[0].clone(), value[0].clone()]).unwrap()
    )
    .is_err());
    assert!(decode_removals(&valid.replace("\"schema\":5", "\"schema\":4")).is_err());
    assert!(decode_removals(&valid.replace("linear-calibration-v1", "post-dcp-v1")).is_err());
    assert!(edit(RECORDS, &rows[0]["id"], "set-active", None, None).is_err());
    assert!(edit(RECORDS, &rows[0]["id"], "delete", Some(false), None).is_err());
    let identical = format!(
        "[{},{}]",
        &RECORDS.trim()[1..RECORDS.trim().len() - 1],
        &RECORDS.trim()[1..RECORDS.trim().len() - 1]
    );
    let separate = entries(&identical);
    assert_ne!(separate[0]["id"], separate[1]["id"]);
}

#[test]
fn generated_host_contract_matches_the_serialized_rust_entry() {
    let value = entries(RECORDS).remove(0);
    let actual: BTreeSet<_> = value
        .as_object()
        .unwrap()
        .keys()
        .map(String::as_str)
        .collect();
    let expected: BTreeSet<_> = SAVED_REMOVAL_ENTRY_FIELDS
        .iter()
        .map(|(name, _)| *name)
        .collect();
    assert_eq!(actual, expected);
}
