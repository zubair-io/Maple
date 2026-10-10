//! Real Rust/C-API qualification probe (#3941), no shipping-quality assertion.
use maple_removal::{
    OrtRuntime, PersonDetector, RemovalReconstructor, RemovalRunOptions, SmartSelector,
};
use raw_core::{
    stages::removal_smart::mask_from_logits_json,
    types::accepted_removal::{ContentDigest, SourceAnchor},
};
use serde_json::json;
use std::{error::Error, fs, path::Path, time::Instant};

fn floats(path: &Path) -> Result<Vec<f32>, Box<dyn Error>> {
    let bytes = fs::read(path)?;
    if bytes.len() % 4 != 0 {
        return Err("float file length mismatch".into());
    }
    Ok(bytes
        .chunks_exact(4)
        .map(|v| f32::from_le_bytes(v.try_into().unwrap()))
        .collect())
}

fn save_floats(path: &Path, values: &[f32]) -> Result<(), Box<dyn Error>> {
    let bytes: Vec<u8> = values.iter().flat_map(|v| v.to_le_bytes()).collect();
    fs::write(path, bytes)?;
    Ok(())
}

fn main() -> Result<(), Box<dyn Error>> {
    let args: Vec<_> = std::env::args_os().skip(1).collect();
    if args.len() != 7 {
        return Err("usage: native-removal-probe MODELS DYLIB CONTEXT SELECTION DETECTION ANCHOR_CONTEXT OUTPUT".into());
    }
    let paths: Vec<_> = args.iter().map(Path::new).collect();
    let [root, dylib, context, selection, detection, anchor_context, output] = paths.as_slice()
    else {
        unreachable!()
    };
    fs::create_dir_all(output)?;
    let runtime = OrtRuntime::preflight(Some(dylib))?;
    let cancel = RemovalRunOptions::new()?;
    let mut reconstruction = RemovalReconstructor::load(&root.join("lama/native-build"), &runtime)?;
    let input = floats(&context.join("input.f32"))?;
    let masks = floats(&context.join("masks.f32"))?;
    if masks.len() != 2 * 1024 * 1024 {
        return Err("invalid generation plane count".into());
    }
    let start = Instant::now();
    let generated = reconstruction.generate(&input, &masks[..1024 * 1024], &cancel)?;
    let reconstruction_ms = start.elapsed().as_secs_f64() * 1000.0;
    save_floats(&output.join("result.f32"), &generated)?;
    let cancelled = RemovalRunOptions::new()?;
    cancelled.terminate()?;
    if reconstruction
        .generate(&input, &masks[..1024 * 1024], &cancelled)
        .is_ok()
    {
        return Err("cancelled reconstruction succeeded".into());
    }
    let mut selector = SmartSelector::load(&root.join("mobile-sam/native-build"), &runtime)?;
    let image = image::open(selection.join("input.png"))?.to_rgb8();
    if image.dimensions() != (1024, 1024) {
        return Err("invalid selection context size".into());
    }
    let rgb: Vec<f32> = (0..3)
        .flat_map(|channel| image.pixels().map(move |p| f32::from(p[channel])))
        .collect();
    let context_json: serde_json::Value =
        serde_json::from_slice(&fs::read(anchor_context.join("context.json"))?)?;
    let source: SourceAnchor = serde_json::from_value(context_json["source_anchor"].clone())?;
    let request = fs::read_to_string(selection.join("request.json"))?;
    let start = Instant::now();
    let embedding = selector.encode(&source, &request, &rgb, &cancel)?;
    let encoder_ms = start.elapsed().as_secs_f64() * 1000.0;
    let start = Instant::now();
    let intent = selector.refine(&source, &embedding, &request, &cancel)?;
    let decoder_ms = start.elapsed().as_secs_f64() * 1000.0;
    fs::write(output.join("intent.mimf"), &intent)?;
    let reference_logits = floats(&selection.join("results/logits-0.f32"))?;
    let reference_scores: Vec<f32> =
        serde_json::from_slice(&fs::read(selection.join("results/scores-0.json"))?)?;
    let expected_intent = mask_from_logits_json(&request, &reference_logits, &reference_scores)?;
    let intent_identical = intent == expected_intent;
    let stale = SourceAnchor {
        original: ContentDigest::for_bytes(b"other raw"),
        ..source
    };
    if selector
        .refine(&stale, &embedding, &request, &cancel)
        .is_ok()
    {
        return Err("stale embedding accepted".into());
    }
    let mut detector = PersonDetector::load(&root.join("rtdetr/native-build"), &runtime)?;
    let data = floats(&detection.join("input.f32"))?;
    let meta: serde_json::Value = serde_json::from_slice(&fs::read(detection.join("input.json"))?)?;
    let size: [u32; 2] = serde_json::from_value(meta["size"].clone())?;
    let start = Instant::now();
    let proposals = detector.detect(&data, size, &cancel)?;
    let detection_ms = start.elapsed().as_secs_f64() * 1000.0;
    fs::write(
        output.join("detections.json"),
        serde_json::to_vec_pretty(&proposals)?,
    )?;
    let report = json!({
        "runtime": runtime.version(), "provider": "CPUExecutionProvider",
        "reconstruction_ms": reconstruction_ms, "encoder_ms": encoder_ms,
        "decoder_ms": decoder_ms, "detection_ms": detection_ms,
        "intent_identical_to_ort_130_reference": intent_identical,
        "stale_embedding_rejected": true, "cancelled_reconstruction_rejected": true,
        "detections": proposals.len(), "release_qualified": false,
        "qualification": "Actual Rust C-API CPU execution only; UI, provisioning, static iOS/device and photographic gates remain"
    });
    fs::write(
        output.join("report.json"),
        serde_json::to_vec_pretty(&report)?,
    )?;
    println!("{report}");
    if !intent_identical {
        return Err("native intent differs from reference".into());
    }
    Ok(())
}
