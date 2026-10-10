//! #3941: actual PreparedRemovalGeneration patch through full RAW development.
//! This verifies recorded native tensors and assets; it does not exercise UI.
use super::{calibration, decode_raw, masks, read_rgb, Context, ProbePlate, ProbeResult};
use raw_core::pipeline::{removal_calibration_source_anchor, PreparedRemovalGeneration};
use raw_core::types::accepted_removal::ContentDigest;
use serde_json::{json, Value};
use std::{fs, path::Path};

fn floats(bytes: &[u8], planar: bool) -> ProbeResult<Vec<f32>> {
    read_rgb(bytes, 1024, planar)?;
    Ok(bytes
        .chunks_exact(4)
        .map(|v| f32::from_le_bytes(v.try_into().unwrap()))
        .collect())
}

pub(super) fn bake(
    path: &Path,
    directory: &Path,
    reconstruction: &Path,
    output: &Path,
) -> ProbeResult<()> {
    if output.exists() {
        return Err("choose a fresh editor-patch bake directory".into());
    }
    let (bytes, raw) = decode_raw(path)?;
    let context_bytes = fs::read(directory.join("context.json"))?;
    let context: Context = serde_json::from_slice(&context_bytes)?;
    context.original.verify(&bytes)?;
    let source = removal_calibration_source_anchor(&raw, &context.original)?;
    if context.plate != ProbePlate::LinearCalibrationV1
        || context.release_qualified
        || context.window.width != 1024
        || context.window.height != 1024
        || context.source_anchor.as_ref() != Some(&source)
    {
        return Err("editor-patch bake requires the exact native calibration source".into());
    }
    let scene_bytes = fs::read(directory.join("scene.f32"))?;
    context.scene.verify(&scene_bytes)?;
    let input_bytes = fs::read(directory.join("input.f32"))?;
    context.model_input.verify(&input_bytes)?;
    let report_bytes = fs::read(reconstruction.join("report.json"))?;
    let report: Value = serde_json::from_slice(&report_bytes)?;
    let editor = &report["editor_encoding"];
    let mask_recipe: Value = serde_json::from_slice(&fs::read(directory.join("masks.json"))?)?;
    let request = json!({
        "schema": 1, "source": source, "masks": mask_recipe["request"],
        "model": report["model"], "model_version": editor["request"]["model_version"],
    });
    let prepared = PreparedRemovalGeneration::prepare(
        &request.to_string(),
        "[]",
        &floats(&scene_bytes, false)?,
        &fs::read(directory.join("intent.mimf"))?,
        &fs::read(directory.join("protected.mimf"))?,
    )?;
    let input = floats(&input_bytes, true)?;
    let (coverage, generation_masks) = masks::coverage(
        directory,
        context.window,
        [context.source_width, context.source_height],
    )?;
    let planes = fs::read(directory.join("masks.f32"))?;
    let hole: Vec<_> = planes[..coverage.len() * 4]
        .chunks_exact(4)
        .map(|v| f32::from_le_bytes(v.try_into().unwrap()))
        .collect();
    let result_bytes = fs::read(reconstruction.join("result.f32"))?;
    let result_digest = ContentDigest::for_bytes(&result_bytes);
    if serde_json::to_value(ContentDigest::for_bytes(&context_bytes))? != report["context_digest"]
        || serde_json::to_value(ContentDigest::for_bytes(&input_bytes))? != report["input_digest"]
        || serde_json::to_value(ContentDigest::for_bytes(&planes))?
            != report["generation_masks_digest"]
        || prepared
            .rgb()
            .iter()
            .map(|v| v.to_bits())
            .ne(input.iter().map(|v| v.to_bits()))
        || prepared
            .hole()
            .iter()
            .map(|v| v.to_bits())
            .ne(hole.iter().map(|v| v.to_bits()))
        || serde_json::from_str::<Value>(prepared.request())? != editor["request"]
        || serde_json::to_value(&result_digest)? != report["result_digest"]
    {
        return Err("editor-patch tensors, request or reconstruction identity differs".into());
    }
    let identity = fs::read(reconstruction.join("editor-identity.f16"))?;
    let replacement = fs::read(reconstruction.join("editor-patch.f16"))?;
    if identity != prepared.finish(&input, raw_core::CancelToken::never())?
        || replacement
            != prepared.finish(
                &floats(&result_bytes, true)?,
                raw_core::CancelToken::never(),
            )?
        || serde_json::to_value(ContentDigest::for_bytes(&identity))? != editor["identity_digest"]
        || serde_json::to_value(ContentDigest::for_bytes(&replacement))? != editor["patch_digest"]
    {
        return Err("stored editor patches differ from current generation finish".into());
    }
    calibration::bake(calibration::Bake {
        raw: &raw,
        path,
        context: &context,
        output,
        identity: &identity,
        replacement: &replacement,
        coverage: &coverage,
        generation_masks,
        model_result: result_digest,
    })?;
    fs::write(
        output.join("editor-patch-proof.json"),
        serde_json::to_vec_pretty(&json!({
            "reconstruction_report": ContentDigest::for_bytes(&report_bytes),
            "input_bits_equal": true, "hole_bits_equal": true,
            "identity_bytes_equal": true, "replacement_bytes_equal": true,
            "replacement": ContentDigest::for_bytes(&replacement),
            "release_qualified": false,
            "scope": "Actual source-bound editor generation finish bytes developed across 18 native RAW grades. Planner, UI, live GPU, export and supported-device gates are not exercised.",
        }))?,
    )?;
    Ok(())
}
