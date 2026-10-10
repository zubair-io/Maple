//! Shared accepted-record preparation (#3936). No host duplicates the saved
//! wire format, digest naming or context dependency computation.
use crate::types::accepted_removal::{
    AcceptedRemoval, ContentDigest, NativeWindow, RemovalPlate, SourceAnchor,
};
use crate::types::{BakeGrade, Removal};
use serde::Deserialize;

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Request {
    #[serde(default)]
    plate: RemovalPlate,
    source: SourceAnchor,
    patch_window: NativeWindow,
    context_window: NativeWindow,
    model: ContentDigest,
    recipe: ContentDigest,
    model_version: String,
    bake: BakeGrade,
}

/// Returns the complete proposed sidecar attribute. Hosts publish both assets,
/// then CAS this attribute with the existing XMP writer before reporting Saved.
/// Unknown element kinds remain in the list verbatim as JSON values; recognized
/// unsupported schemas and malformed companions fail before any publication.
pub fn prepare_accepted_removal(
    request: &str,
    prior: &str,
    mask: &[u8],
    patch: &[u8],
) -> Result<String, String> {
    let request: Request =
        serde_json::from_str(request).map_err(|e| format!("removal request: {e}"))?;
    let earlier = crate::types::inpaint::decode_removals(prior)?;
    let mut accepted = AcceptedRemoval {
        plate: request.plate,
        source: request.source,
        mask: ContentDigest::for_bytes(mask),
        patch_window: request.patch_window,
        context_window: request.context_window,
        model: request.model,
        recipe: request.recipe,
        dependencies: Vec::new(),
    };
    accepted.dependencies = super::removal_context_dependencies(&earlier, &accepted)?;
    let region = accepted
        .patch_window
        .region(accepted.source.width, accepted.source.height);
    let removal = Removal {
        operation: None,
        accepted: Some(accepted),
        region,
        patch_ref: ContentDigest::for_bytes(patch).as_str().into(),
        model_version: request.model_version,
        bake: request.bake,
    };
    super::resolve_accepted_removal(
        &removal,
        &removal.accepted.as_ref().unwrap().source,
        mask,
        patch,
    )?;
    let mut values: serde_json::Value =
        serde_json::from_str(prior).map_err(|e| format!("removal stack: {e}"))?;
    values
        .as_array_mut()
        .ok_or_else(|| "removal stack must be an array".to_string())?
        .push(crate::types::inpaint::removal_to_json(&removal));
    Ok(values.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::{removal_mask::RemovalMask, InpaintPatch};

    #[test]
    fn preparation_preserves_unknown_records_and_verifies_native_assets() {
        let source = SourceAnchor {
            original: ContentDigest::for_bytes(b"RAW"),
            decode: ContentDigest::for_bytes(b"recipe"),
            width: 2,
            height: 1,
        };
        let mask = super::super::removal_mask_to_bytes(&RemovalMask {
            source_width: 2,
            source_height: 1,
            x: 0,
            y: 0,
            width: 2,
            height: 1,
            pixels: vec![255, 0],
        })
        .unwrap();
        let patch = super::super::patch_to_bytes(&InpaintPatch {
            width: 2,
            height: 1,
            origin: [0.0, 0.0],
            extent: [1.0, 1.0],
            pixels: vec![[0.18, -0.125, 8.0]; 2],
            coverage: vec![1.0, 0.0],
        })
        .unwrap();
        let request = serde_json::json!({"source":source,"patch_window":{"x":0,"y":0,"width":2,"height":1},"context_window":{"x":0,"y":0,"width":2,"height":1},"model":ContentDigest::for_bytes(b"model"),"recipe":ContentDigest::for_bytes(b"photographic mapping"),"model_version":"native fixture","bake":{"temp":6500,"tint":0,"ev":0}}).to_string();
        let prior = r#"[{"kind":"future-edit","payload":{"unrecognized":true}}]"#;
        let prepared = prepare_accepted_removal(&request, prior, &mask, &patch).unwrap();
        let v: serde_json::Value = serde_json::from_str(&prepared).unwrap();
        let original: serde_json::Value = serde_json::from_str(prior).unwrap();
        assert_eq!(v[0], original[0]);
        assert_eq!(v[1]["schema"], 3);
        assert_eq!(
            crate::types::inpaint::decode_removals(&prepared)
                .unwrap()
                .len(),
            1
        );
        let mut linear_request: serde_json::Value = serde_json::from_str(&request).unwrap();
        linear_request["plate"] = "linear-calibration-v1".into();
        let linear =
            prepare_accepted_removal(&linear_request.to_string(), prior, &mask, &patch).unwrap();
        let linear_value: serde_json::Value = serde_json::from_str(&linear).unwrap();
        assert_eq!(linear_value[0], original[0]);
        assert_eq!(linear_value[1]["schema"], 4);
        assert_eq!(
            linear_value[1]["accepted"]["plate"],
            "linear-calibration-v1"
        );
        linear_request["plate"] = "future-plate-v2".into();
        assert!(
            prepare_accepted_removal(&linear_request.to_string(), prior, &mask, &patch).is_err()
        );
        assert!(prepare_accepted_removal(&request, prior, &[], &patch).is_err());
        assert!(prepare_accepted_removal(&request, "{}", &mask, &patch).is_err());
        assert!(prepare_accepted_removal(
            &request.replace("\"temp\":6500", "\"temp\":1e100"),
            prior,
            &mask,
            &patch
        )
        .is_err());
    }
}
