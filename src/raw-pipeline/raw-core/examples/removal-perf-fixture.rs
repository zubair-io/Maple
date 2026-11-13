//! Controlled accepted stacks for the real 100MP editor benchmark (#1472).
//! Constant scene-linear patches measure composition cost, not AI quality.
//! The original is read only; output must be a new, disposable directory.
use raw_core::pipeline::{patch_to_bytes, prepare_accepted_removal, removal_mask_to_bytes};
use raw_core::types::accepted_removal::{ContentDigest, NativeWindow};
use raw_core::types::{removal_mask::RemovalMask, InpaintPatch};
use std::path::PathBuf;

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let args: Vec<_> = std::env::args().skip(1).collect();
    if args.len() != 2 {
        return Err("usage: removal-perf-fixture ORIGINAL_RAW NEW_OUTPUT_DIRECTORY".into());
    }
    let original = PathBuf::from(&args[0]);
    let output = PathBuf::from(&args[1]);
    let bytes = std::fs::read(&original)?;
    let digest = ContentDigest::for_bytes(&bytes);
    let ext = original
        .extension()
        .and_then(|ext| ext.to_str())
        .unwrap_or("");
    let raw = raw_core::decode_raw(&bytes, ext)?;
    let source = raw_core::pipeline::removal_calibration_source_anchor(&raw, &digest)?;
    if u64::from(source.width) * u64::from(source.height) < 100_000_000 {
        return Err("this benchmark requires the canonical 100MP RAW, no smaller fallback".into());
    }
    // Refuse to overwrite any existing directory, including a photo library.
    std::fs::create_dir(&output)?;
    let companions = output.join(".maple/inpaint");
    std::fs::create_dir_all(&companions)?;
    std::fs::write(output.join("stack-0.xmp"), sidecar("[]")?)?;
    let mut records = "[]".to_string();
    for index in 0..10 {
        let window = NativeWindow {
            x: source.width / 8 + (index % 5) * source.width / 6,
            y: source.height / 3 + (index / 5) * source.height / 3,
            width: 512,
            height: 512,
        };
        window.validate(source.width, source.height)?;
        let mask = removal_mask_to_bytes(&RemovalMask {
            source_width: source.width,
            source_height: source.height,
            x: window.x,
            y: window.y,
            width: window.width,
            height: window.height,
            pixels: vec![255; 512 * 512],
        })?;
        let region = window.region(source.width, source.height);
        let patch = patch_to_bytes(&InpaintPatch {
            width: window.width,
            height: window.height,
            origin: [region[0], region[1]],
            extent: [region[2], region[3]],
            pixels: vec![[0.5, 0.05, 0.1]; 512 * 512],
            coverage: vec![1.0; 512 * 512],
        })?;
        let request = serde_json::json!({
            "source": source, "patch_window": window, "context_window": window,
            "plate": "linear-calibration-v1",
            "model": ContentDigest::for_bytes(b"controlled performance fixture; no inference"),
            "recipe": ContentDigest::for_bytes(b"constant scene-linear RGB; 512 square; full coverage"),
            "model_version": "controlled performance fixture; not AI reconstruction",
            "bake": {"temp":6500,"tint":0,"ev":0}
        }).to_string();
        records = prepare_accepted_removal(&request, &records, &mask, &patch)?;
        for (data, suffix) in [(&mask, "mask"), (&patch, "f16")] {
            let name = format!("{}.{}", ContentDigest::for_bytes(data).hex(), suffix);
            std::fs::write(companions.join(name), data)?;
        }
        if index == 0 || index == 9 {
            std::fs::write(
                output.join(format!("stack-{}.xmp", index + 1)),
                sidecar(&records)?,
            )?;
        }
    }
    std::fs::write(
        output.join("source-anchor.json"),
        serde_json::to_vec_pretty(&source)?,
    )?;
    if ContentDigest::for_bytes(&std::fs::read(&original)?) != digest {
        return Err("original changed while generating benchmark fixtures".into());
    }
    println!(
        "Created controlled 0/1/10 stacks for {}x{} source {}",
        source.width,
        source.height,
        digest.as_str()
    );
    Ok(())
}

fn sidecar(records: &str) -> Result<String, Box<dyn std::error::Error>> {
    // xmp::serialize is an attribute fragment, not a document, and does not
    // serialize accepted records. Supply the real fixture envelope explicitly.
    let fragment = raw_core::xmp::serialize(&Default::default());
    let escaped = records.replace('&', "&amp;").replace('"', "&quot;");
    let xml = format!(
        r#"<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><rdf:Description xmlns:crs="http://ns.adobe.com/camera-raw-settings/1.0/" xmlns:papp="http://ns.justmaple.app/photo/1.0/"{fragment} papp:InpaintRemovals="{escaped}"/></rdf:RDF></x:xmpmeta>"#
    );
    let expected = raw_core::types::inpaint::decode_removals(records)?;
    let actual = raw_core::xmp::parse(&xml)?;
    if actual.inpaint_removals != expected {
        return Err("accepted records changed during XMP fixture round trip".into());
    }
    Ok(xml)
}
