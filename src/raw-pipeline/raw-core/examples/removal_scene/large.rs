//! #3941: one canonical native 2048 context, not app admission or an XMP write.
use super::{
    calibration, decode_raw, encoding, pack, read_rgb, save_png, Context, ProbePlate, ProbeResult,
};
use raw_core::{
    cancel::CancelToken,
    pipeline::{
        patch_to_bytes, removal_calibration_source_anchor, removal_mask_from_bytes,
        render_removal_calibration_context, render_removal_calibration_plate,
    },
    types::{
        accepted_removal::{ContentDigest, NativeWindow, SourceAnchor},
        InpaintPatch,
    },
};
use serde::{Deserialize, Serialize};
use std::path::Path;
#[path = "large_masks.rs"]
mod large_masks;
use large_masks::SIDE;

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Inputs {
    source: SourceAnchor,
    intent: ContentDigest,
    protected: ContentDigest,
}

fn prepared(directory: &Path, window: NativeWindow) -> ProbeResult<Vec<f32>> {
    let inputs: Inputs = serde_json::from_slice(&std::fs::read(directory.join("inputs.json"))?)?;
    let intent = std::fs::read(directory.join("intent.mimf"))?;
    let protected = std::fs::read(directory.join("protected.mimf"))?;
    inputs.intent.verify(&intent)?;
    inputs.protected.verify(&protected)?;
    Ok(large_masks::planes(
        &removal_mask_from_bytes(&intent)?,
        &removal_mask_from_bytes(&protected)?,
        window,
    )?)
}

pub(super) fn encode(
    raw_path: &Path,
    pins: &Path,
    intent_path: &Path,
    protected_path: &Path,
    output: &Path,
    reference_path: Option<&Path>,
    photographic_contrast: bool,
) -> ProbeResult<()> {
    if output.exists() {
        return Err("choose a fresh large RAW research output".into());
    }
    let inputs: Inputs = serde_json::from_slice(&std::fs::read(pins)?)?;
    let intent = std::fs::read(intent_path)?;
    let protected = std::fs::read(protected_path)?;
    inputs.intent.verify(&intent)?;
    inputs.protected.verify(&protected)?;
    let mask = removal_mask_from_bytes(&intent)?;
    let protection = removal_mask_from_bytes(&protected)?;
    let reference: Option<Context> = reference_path
        .map(|path| -> ProbeResult<Context> {
            let context: Context = serde_json::from_slice(&std::fs::read(path)?)?;
            if context.plate != ProbePlate::LinearCalibrationV1
                || context.release_qualified
                || context.source_anchor.as_ref() != Some(&inputs.source)
                || context.original != inputs.source.original
                || (context.source_width, context.source_height)
                    != (inputs.source.width, inputs.source.height)
            {
                return Err("reference context source or calibration recipe differs".into());
            }
            Ok(context)
        })
        .transpose()?;
    let window = match &reference {
        Some(context) => context.window,
        None => large_masks::window(&mask)?,
    };
    let planes = large_masks::planes(&mask, &protection, window)?;
    let (bytes, raw) = decode_raw(raw_path)?;
    inputs.source.original.verify(&bytes)?;
    let source = removal_calibration_source_anchor(&raw, &ContentDigest::for_bytes(&bytes))?;
    if source != inputs.source
        || (mask.source_width, mask.source_height) != (source.width, source.height)
    {
        return Err("large research masks differ from pinned RAW source anchor".into());
    }
    let mut pixels = vec![[0.0_f32; 3]; (SIDE * SIDE) as usize];
    for dy in [0, 1024] {
        for dx in [0, 1024] {
            let tile = render_removal_calibration_context(
                &raw,
                NativeWindow {
                    x: window.x + dx,
                    y: window.y + dy,
                    width: 1024,
                    height: 1024,
                },
                CancelToken::never(),
            )?;
            for y in 0..1024 {
                let start = ((dy + y) * SIDE + dx) as usize;
                pixels[start..start + 1024]
                    .copy_from_slice(&tile.pixels[(y * 1024) as usize..((y + 1) * 1024) as usize]);
            }
        }
    }
    // Whole-frame oracle is explicitly research only. Nothing in the app's
    // cold context or slider loop is replaced by a full-frame fallback.
    let full = render_removal_calibration_plate(&raw, CancelToken::never())?;
    let oracle = calibration::crop(&full, window)?;
    let mismatches = pixels
        .iter()
        .zip(&oracle.pixels)
        .flat_map(|(a, b)| (0..3).map(move |c| a[c].to_bits() != b[c].to_bits()))
        .filter(|v| *v)
        .count();
    if mismatches != 0 {
        return Err("joined native tiles differ from whole-frame calibration oracle".into());
    }
    let encoding = encoding::ProbeEncoding::fit(&pixels, false, photographic_contrast)?;
    let model = encoding.encode(&pixels)?;
    let scene = pack(pixels.iter().flatten().copied());
    let input = pack((0..3).flat_map(|c| model.iter().map(move |p| p[c])));
    let context = Context {
        plate: ProbePlate::LinearCalibrationV1,
        original: ContentDigest::for_bytes(&bytes),
        source_anchor: Some(source),
        window,
        source_width: mask.source_width,
        source_height: mask.source_height,
        scene: ContentDigest::for_bytes(&scene),
        model_input: ContentDigest::for_bytes(&input),
        encoding,
        release_qualified: false,
    };
    if let Some(reference) = &reference {
        // Verify the earlier recipe against these exact native RAW pixels before
        // allowing an explicitly requested encoding comparison. A matching scene
        // hash alone must not hide changed recipe metadata or model input bytes.
        let reference_model = reference.encoding.encode(&pixels)?;
        let reference_input = pack((0..3).flat_map(|c| reference_model.iter().map(move |p| p[c])));
        if reference.scene != context.scene
            || reference.model_input != ContentDigest::for_bytes(&reference_input)
            || (!photographic_contrast && reference.model_input != context.model_input)
        {
            return Err("reference context pixels or model input recipe changed".into());
        }
    }
    std::fs::create_dir_all(output)?;
    for (name, data) in [
        ("scene.f32", scene),
        ("input.f32", input),
        ("intent.mimf", intent),
        ("protected.mimf", protected),
        ("masks.f32", pack(planes.iter().copied())),
    ] {
        std::fs::write(output.join(name), data)?;
    }
    std::fs::write(
        output.join("inputs.json"),
        serde_json::to_vec_pretty(&inputs)?,
    )?;
    std::fs::write(
        output.join("context.json"),
        serde_json::to_vec_pretty(&context)?,
    )?;
    save_png(output.join("input.png"), &model, SIDE)?;
    std::fs::write(
        output.join("preparation.json"),
        serde_json::to_vec_pretty(&serde_json::json!({
            "release_qualified": false, "window": window, "joined_tile_mismatch_channels": mismatches,
            "reference_context": reference_path,
            "encoding_comparison": photographic_contrast,
            "model_input_native_size": [SIDE,SIDE], "whole_frame_oracle": true, "resampled": false,
            "hole_pixels": planes[..(SIDE*SIDE) as usize].iter().filter(|v| **v == 1.0).count(),
            "mask_strategy": "Union of unchanged shared native mask preparation; one joint model inference, no independently reconstructed pieces"
        }))?,
    )?;
    Ok(())
}

pub(super) fn bake(path: &Path, directory: &Path, result: &Path, output: &Path) -> ProbeResult<()> {
    if output.exists() {
        return Err("choose a fresh large scene bake output".into());
    }
    let (bytes, raw) = decode_raw(path)?;
    let context: Context = serde_json::from_slice(&std::fs::read(directory.join("context.json"))?)?;
    context.original.verify(&bytes)?;
    let anchor = removal_calibration_source_anchor(&raw, &ContentDigest::for_bytes(&bytes))?;
    if context.plate != ProbePlate::LinearCalibrationV1
        || context.window.width != SIDE
        || context.window.height != SIDE
        || context.release_qualified
        || context.source_anchor.as_ref() != Some(&anchor)
        || (context.source_width, context.source_height) != (anchor.width, anchor.height)
    {
        return Err("large scene bake source, geometry or plate differs".into());
    }
    let inputs: Inputs = serde_json::from_slice(&std::fs::read(directory.join("inputs.json"))?)?;
    if inputs.source != anchor {
        return Err("large mask recipe source differs".into());
    }
    let planes = prepared(directory, context.window)?;
    let mask_bytes = std::fs::read(directory.join("masks.f32"))?;
    if mask_bytes != pack(planes.iter().copied()) {
        return Err("large shared mask planes changed".into());
    }
    let scene = std::fs::read(directory.join("scene.f32"))?;
    context.scene.verify(&scene)?;
    let input = std::fs::read(directory.join("input.f32"))?;
    context.model_input.verify(&input)?;
    let original = read_rgb(&scene, SIDE, false)?;
    let model_input = read_rgb(&input, SIDE, true)?;
    let encoded = context.encoding.encode(&original)?;
    let expected_input = pack((0..3).flat_map(|c| encoded.iter().map(move |p| p[c])));
    if expected_input != input {
        return Err("large model input differs from recorded source and encoding recipe".into());
    }
    let identity = context.encoding.decode(&model_input)?;
    let result_bytes = std::fs::read(result)?;
    let replacement = context
        .encoding
        .decode(&read_rgb(&result_bytes, SIDE, true)?)?;
    let coverage = &planes[(SIDE * SIDE) as usize..];
    let region = context
        .window
        .region(context.source_width, context.source_height);
    let patch = |pixels| {
        patch_to_bytes(&InpaintPatch {
            width: SIDE,
            height: SIDE,
            origin: [region[0], region[1]],
            extent: [region[2], region[3]],
            pixels,
            coverage: coverage.to_vec(),
        })
    };
    calibration::bake(calibration::Bake {
        raw: &raw,
        path,
        context: &context,
        output,
        identity: &patch(identity)?,
        replacement: &patch(replacement)?,
        coverage,
        generation_masks: Some(ContentDigest::for_bytes(&mask_bytes)),
        model_result: ContentDigest::for_bytes(&result_bytes),
    })
}
