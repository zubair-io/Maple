//! Replay real cached-model output through the shared native-mask boundary
//! (#3942). Diagnostic only; it does not author XMP or qualify a model.
use std::path::PathBuf;

fn run() -> Result<(), Box<dyn std::error::Error>> {
    let args: Vec<_> = std::env::args_os().skip(1).map(PathBuf::from).collect();
    if args.len() == 2 {
        let prepared = raw_core::stages::removal_smart::prepare_strokes_json(
            &std::fs::read_to_string(&args[0])?,
        )?;
        std::fs::write(&args[1], &prepared)?;
        println!(
            "{}",
            raw_core::stages::removal_smart::model_prompts_json(&prepared)?
        );
        return Ok(());
    }
    if args.len() != 4 {
        return Err(
            "usage: removal-selection-probe GESTURES.json PREPARED.json | REQUEST.json LOGITS.f32 SCORES.json OUTPUT.mimf".into(),
        );
    }
    let request = std::fs::read_to_string(&args[0])?;
    let expected = 4 * 1024 * 1024 * 4;
    if std::fs::metadata(&args[1])?.len() != expected {
        return Err("expected four 1024-square f32 logit planes".into());
    }
    let bytes = std::fs::read(&args[1])?;
    let logits: Vec<_> = bytes
        .chunks_exact(4)
        .map(|v| f32::from_le_bytes(v.try_into().unwrap()))
        .collect();
    let scores: Vec<f32> = serde_json::from_str(&std::fs::read_to_string(&args[2])?)?;
    let mask = raw_core::stages::removal_smart::mask_from_logits_json(&request, &logits, &scores)?;
    let geometry = raw_core::pipeline::removal_mask_from_bytes(&mask)?;
    std::fs::write(&args[3], &mask)?;
    println!(
        "{}",
        serde_json::json!({
            "window":[geometry.x,geometry.y,geometry.width,geometry.height],
            "source":[geometry.source_width,geometry.source_height],
            "selected_pixels":geometry.pixels.iter().filter(|v| **v==255).count(),
            "asset":raw_core::types::accepted_removal::ContentDigest::for_bytes(&mask).as_str(),
            "release_qualified":false
        })
    );
    Ok(())
}

fn main() {
    if let Err(error) = run() {
        eprintln!("{error}");
        std::process::exit(1);
    }
}
