//! #3941: exact shared source-framed selection proxy for person-model research.
//! Read-only RAW input; no XMP, generated edit or model admission is authored.
use raw_core::{
    pipeline::{removal_calibration_source_anchor, render_removal_selection_proxy, RawInput},
    types::accepted_removal::ContentDigest,
};
use std::{fs, path::PathBuf};

fn run() -> Result<(), Box<dyn std::error::Error>> {
    let args: Vec<_> = std::env::args_os().skip(1).map(PathBuf::from).collect();
    let [input, output] = args.as_slice() else {
        return Err("usage: removal-people-proxy RAW OUTPUT_DIRECTORY".into());
    };
    if output.exists() {
        return Err("choose a fresh proxy diagnostic directory".into());
    }
    let original = fs::read(input)?;
    let ext = input
        .extension()
        .and_then(|value| value.to_str())
        .ok_or("missing RAW extension")?;
    let raw = raw_core::decode_raw(&original, &ext.to_lowercase())?;
    let original_digest = ContentDigest::for_bytes(&original);
    let source = removal_calibration_source_anchor(&raw, &original_digest)?;
    let (width, height, rgb) = render_removal_selection_proxy(
        &raw,
        &original_digest,
        Some(RawInput::Path(input)),
        None,
        &[],
    )?;
    if fs::read(input)? != original {
        return Err("original RAW changed during proxy preparation".into());
    }
    let report = serde_json::json!({
        "source": source,
        "selectionInput": {
            "proxySize": [width, height],
            "contentSize": [width, height],
            "proxyDigest": ContentDigest::for_bytes(&rgb),
        },
        "detected": [], "detectedMasks": [],
        "originalUnchanged": true,
        "releaseQualified": false,
        "scope": "Actual shared source-framed RAW selection proxy without edits. No host encoder tensor, detector/SAM instances, photographic fill or ownership qualification.",
    });
    fs::create_dir(output)?;
    fs::write(output.join("selection-proxy.rgb8"), rgb)?;
    fs::write(
        output.join("report.json"),
        serde_json::to_vec_pretty(&report)?,
    )?;
    println!("{}", report);
    Ok(())
}

fn main() {
    if let Err(error) = run() {
        eprintln!("{error}");
        std::process::exit(1);
    }
}
