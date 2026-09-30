//! Generate the cross-host durable-removal fixture (#3940). Synthetic input
//! is confined to test resources; this never runs in a shipping editor.
use raw_core::pipeline::{patch_to_bytes, prepare_accepted_removal, removal_mask_to_bytes};
use raw_core::types::accepted_removal::{ContentDigest, NativeWindow, SourceAnchor};
use raw_core::types::{removal_mask::RemovalMask, InpaintPatch};
use std::path::PathBuf;

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let directory = PathBuf::from(
        std::env::args()
            .nth(1)
            .ok_or("provide fixture output directory")?,
    );
    std::fs::create_dir_all(&directory)?;
    let raw = directory.join("source.dng");
    raw_core::test_support::synth_dng::SyntheticGreyDng {
        width: 16,
        height: 8,
        ..Default::default()
    }
    .write_to(&raw)?;
    let source = SourceAnchor {
        original: ContentDigest::for_bytes(&std::fs::read(&raw)?),
        decode: ContentDigest::for_bytes(b"interop fixed anchor"),
        width: 16,
        height: 8,
    };
    let window = NativeWindow {
        x: 4,
        y: 2,
        width: 8,
        height: 4,
    };
    let mask = removal_mask_to_bytes(&RemovalMask {
        source_width: 16,
        source_height: 8,
        x: 4,
        y: 2,
        width: 8,
        height: 4,
        pixels: vec![255; 32],
    })?;
    let region = window.region(16, 8);
    let patch = patch_to_bytes(&InpaintPatch {
        width: 8,
        height: 4,
        origin: [region[0], region[1]],
        extent: [region[2], region[3]],
        pixels: vec![[0.18, -0.125, 8.0]; 32],
        coverage: vec![1.0; 32],
    })?;
    let request = serde_json::json!({"source":source,"patch_window":window,"context_window":{"x":0,"y":0,"width":16,"height":8},"model":ContentDigest::for_bytes(b"interop fixture model"),"recipe":ContentDigest::for_bytes(b"interop photographic recipe"),"model_version":"interop fixture","bake":{"temp":6500,"tint":0,"ev":0}}).to_string();
    let records = prepare_accepted_removal(&request, "[]", &mask, &patch)?;
    for (name, bytes) in [
        ("request.txt", request.as_bytes()),
        ("records.txt", records.as_bytes()),
        ("mask.mimf", mask.as_slice()),
        ("patch.f16", patch.as_slice()),
    ] {
        std::fs::write(directory.join(name), bytes)?;
    }
    std::fs::write(
        directory.join("prior.xmp"),
        r#"<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><rdf:Description xmlns:papp="http://ns.justmaple.app/photo/1.0/" xmlns:foreign="urn:removal-fixture" foreign:Keep="untouched"><foreign:History original="preserved"/></rdf:Description></rdf:RDF></x:xmpmeta>"#,
    )?;
    Ok(())
}
