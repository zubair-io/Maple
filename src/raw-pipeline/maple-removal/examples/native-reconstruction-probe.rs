//! #3941: actual deployed CPU reconstruction on source-bound native float input.
//! Runs independently of detector fixtures; RAW baking/quality remain separate.
use maple_removal::{OrtRuntime, RemovalReconstructor, RemovalRunOptions};
use raw_core::pipeline::PreparedRemovalGeneration;
use raw_core::types::accepted_removal::ContentDigest;
use serde_json::json;
use std::{error::Error, fs, path::Path, time::Instant};

fn floats(path: &Path, count: usize) -> Result<(Vec<u8>, Vec<f32>), Box<dyn Error>> {
    if fs::metadata(path)?.len() != (count * 4) as u64 {
        return Err("native float file length mismatch".into());
    }
    let bytes = fs::read(path)?;
    if bytes.len() != count * 4 {
        return Err("native float file changed while reading".into());
    }
    let values = bytes
        .chunks_exact(4)
        .map(|v| f32::from_le_bytes(v.try_into().unwrap()))
        .collect();
    Ok((bytes, values))
}

fn write_floats(path: &Path, values: &[f32]) -> Result<ContentDigest, Box<dyn Error>> {
    let bytes: Vec<u8> = values.iter().flat_map(|v| v.to_le_bytes()).collect();
    fs::write(path, &bytes)?;
    Ok(ContentDigest::for_bytes(&bytes))
}

fn editor_preparation(
    context: &Path,
    recipe: &serde_json::Value,
    model: &RemovalReconstructor,
    rgb: &[f32],
    hole: &[f32],
) -> Result<PreparedRemovalGeneration, Box<dyn Error>> {
    let (scene_bytes, scene) = floats(&context.join("scene.f32"), 3 * 1024 * 1024)?;
    if serde_json::to_value(ContentDigest::for_bytes(&scene_bytes))? != recipe["scene"] {
        return Err("scene differs from its shared Rust context identity".into());
    }
    let masks: serde_json::Value = serde_json::from_slice(&fs::read(context.join("masks.json"))?)?;
    let request = json!({
        "schema": 1, "source": recipe["source_anchor"], "masks": masks["request"],
        "model": model.model_digest(),
        "model_version": raw_core::types::removal_models::EXPERIMENTAL_REMOVAL_MODELS[0].sha256,
    });
    let prepared = PreparedRemovalGeneration::prepare(
        &request.to_string(),
        "[]",
        &scene,
        &fs::read(context.join("intent.mimf"))?,
        &fs::read(context.join("protected.mimf"))?,
    )?;
    if prepared
        .rgb()
        .iter()
        .map(|v| v.to_bits())
        .ne(rgb.iter().map(|v| v.to_bits()))
        || prepared
            .hole()
            .iter()
            .map(|v| v.to_bits())
            .ne(hole.iter().map(|v| v.to_bits()))
    {
        return Err("recorded tensors differ from current editor preparation".into());
    }
    Ok(prepared)
}

fn main() -> Result<(), Box<dyn Error>> {
    let args: Vec<_> = std::env::args_os().skip(1).collect();
    let verify_editor = args.len() == 5 && args[4] == "--verify-editor-encoding";
    if args.len() != 4 && !verify_editor {
        return Err("usage: native-reconstruction-probe MODELS DYLIB CONTEXT OUTPUT [--verify-editor-encoding]".into());
    }
    let paths: Vec<_> = args[..4].iter().map(Path::new).collect();
    let [models, dylib, context, output] = paths.as_slice() else {
        unreachable!()
    };
    if output.exists() {
        return Err("choose a fresh research output directory".into());
    }
    let metadata = fs::read(context.join("context.json"))?;
    let recipe: serde_json::Value = serde_json::from_slice(&metadata)?;
    if recipe["window"]["width"] != 1024 || recipe["window"]["height"] != 1024 {
        return Err("research input must retain native1024 context".into());
    }
    let plane = 1024 * 1024;
    let (rgb_bytes, rgb) = floats(&context.join("input.f32"), 3 * plane)?;
    let rgb_digest = ContentDigest::for_bytes(&rgb_bytes);
    if serde_json::to_value(&rgb_digest)? != recipe["model_input"] {
        return Err("input differs from its shared Rust context identity".into());
    }
    let (mask_bytes, masks) = floats(&context.join("masks.f32"), 2 * plane)?;
    let runtime = OrtRuntime::preflight(Some(dylib))?;
    let started = Instant::now();
    let mut model = RemovalReconstructor::load(models, &runtime)?;
    let model_open_ms = started.elapsed().as_secs_f64() * 1000.0;
    let prepared = verify_editor
        .then(|| editor_preparation(context, &recipe, &model, &rgb, &masks[..plane]))
        .transpose()?;
    let operation = RemovalRunOptions::new()?;
    let started = Instant::now();
    let generated = model.generate(&rgb, &masks[..plane], &operation)?;
    let inference_ms = started.elapsed().as_secs_f64() * 1000.0;
    let cancelled = RemovalRunOptions::new()?;
    cancelled.terminate()?;
    if model.generate(&rgb, &masks[..plane], &cancelled).is_ok() {
        return Err("pre-cancelled reconstruction published output".into());
    }
    let outside_changed = generated
        .iter()
        .zip(&rgb)
        .enumerate()
        .filter(|(i, (actual, source))| {
            masks[i % plane] == 0.0 && actual.to_bits() != source.to_bits()
        })
        .count();
    let candidate: Vec<f32> = generated
        .iter()
        .zip(&rgb)
        .enumerate()
        .map(|(i, (actual, source))| {
            if masks[i % plane] == 1.0 {
                *actual
            } else {
                *source
            }
        })
        .collect();
    fs::create_dir(output)?;
    let result = write_floats(&output.join("result.f32"), &generated)?;
    let candidate_digest = write_floats(&output.join("candidate.f32"), &candidate)?;
    let editor_patch = if let Some(prepared) = prepared {
        let patch = prepared.finish(&generated)?;
        let identity = prepared.finish(&rgb)?;
        fs::write(output.join("editor-patch.f16"), &patch)?;
        fs::write(output.join("editor-identity.f16"), &identity)?;
        fs::write(output.join("editor-request.json"), prepared.request())?;
        Some(json!({
            "rgb_bits_equal": true, "hole_bits_equal": true,
            "patch_digest": ContentDigest::for_bytes(&patch),
            "identity_digest": ContentDigest::for_bytes(&identity),
            "request": serde_json::from_str::<serde_json::Value>(prepared.request())?,
            "scope": "Current PreparedRemovalGeneration encoding/finish at the recorded native window and mask parameters. Planner/default-mask policy and editor UI are not exercised.",
        }))
    } else {
        None
    };
    let report = json!({
        "runtime": runtime.version(), "provider": "CPUExecutionProvider",
        "model": model.model_digest(), "context": recipe,
        "context_digest": ContentDigest::for_bytes(&metadata),
        "input_digest": rgb_digest, "generation_masks_digest": ContentDigest::for_bytes(&mask_bytes),
        "model_open_ms": model_open_ms, "inference_ms": inference_ms,
        "result_digest": result, "candidate_digest": candidate_digest,
        "model_output_known_samples_changed": outside_changed,
        "candidate_known_samples_changed": 0,
        "cancelled_reconstruction_rejected": true,
        "source_resampled": false, "input_quantized_to_u8": false,
        "clamped": false, "release_qualified": false,
        "editor_encoding": editor_patch,
        "qualification": "Actual deployed Rust CPU adapter only; independent RAW bake, photographic quality, native UI and device budgets remain required."
    });
    fs::write(
        output.join("report.json"),
        serde_json::to_vec_pretty(&report)?,
    )?;
    println!("{report}");
    Ok(())
}
