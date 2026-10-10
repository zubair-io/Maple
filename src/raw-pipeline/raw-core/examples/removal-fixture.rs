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
    let calibration = std::env::args().nth(2).as_deref() == Some("--calibration");
    std::fs::create_dir_all(&directory)?;
    let raw = directory.join("source.dng");
    raw_core::test_support::synth_dng::SyntheticGreyDng {
        width: 16,
        height: 8,
        ..Default::default()
    }
    .write_to(&raw)?;
    let source = if calibration {
        let bytes = std::fs::read(&raw)?;
        let decoded = raw_core::decode_raw(&bytes, "dng")?;
        raw_core::pipeline::removal_calibration_source_anchor(
            &decoded,
            &ContentDigest::for_bytes(&bytes),
        )?
    } else {
        SourceAnchor {
            original: ContentDigest::for_bytes(&std::fs::read(&raw)?),
            decode: ContentDigest::for_bytes(b"interop fixed anchor"),
            width: 16,
            height: 8,
        }
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
    let mut request = serde_json::json!({"source":source,"patch_window":window,"context_window":{"x":0,"y":0,"width":16,"height":8},"model":ContentDigest::for_bytes(b"interop fixture model"),"recipe":ContentDigest::for_bytes(b"interop photographic recipe"),"model_version":"interop fixture","bake":{"temp":6500,"tint":0,"ev":0}});
    if calibration {
        request["plate"] = "linear-calibration-v1".into();
    }
    let request = request.to_string();
    let records = prepare_accepted_removal(&request, "[]", &mask, &patch)?;
    for (name, bytes) in [
        ("request.txt", request.as_bytes()),
        ("records.txt", records.as_bytes()),
        ("mask.mimf", mask.as_slice()),
        ("patch.f16", patch.as_slice()),
    ] {
        std::fs::write(directory.join(name), bytes)?;
    }
    if calibration {
        let xmp = format!(
            r#"<rdf:Description xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#" xmlns:papp="http://ns.justmaple.app/photo/1.0/" papp:InpaintRemovals="{}"/>"#,
            records.replace('"', "&quot;")
        );
        std::fs::write(directory.join("saved.xmp"), &xmp)?;
        let model = raw_core::xmp::parse(&xmp)?;
        let bytes = std::fs::read(&raw)?;
        let raw = raw_core::decode_raw(&bytes, "dng")?;
        let original = ContentDigest::for_bytes(&bytes);
        let assets = std::collections::BTreeMap::from([
            (
                format!("{}.mask", ContentDigest::for_bytes(&mask).hex()),
                mask,
            ),
            (
                format!("{}.f16", ContentDigest::for_bytes(&patch).hex()),
                patch,
            ),
        ]);
        let stack = raw_core::pipeline::ResolvedCalibrationRemovals::prepare(
            &raw,
            &original,
            &model.inpaint_removals,
            &assets,
        )?;
        for cap in [4, 64] {
            let (w, h, pixels) = stack.render_display(
                &raw,
                &original,
                &model,
                raw_core::pipeline::RenderQuality::Auto,
                Some(raw_core::pipeline::RawInput::Bytes {
                    bytes: &bytes,
                    ext: "dng",
                }),
                Some(cap),
                None,
            )?;
            std::fs::write(
                directory.join(format!("preview-{cap}-q90.jpg")),
                raw_core::jpeg::encode(w, h, &pixels, 90)?,
            )?;
            std::fs::write(directory.join(format!("preview-{cap}.rgb")), pixels)?;
            std::fs::write(
                directory.join(format!("preview-{cap}.json")),
                format!("{{ \"height\": {h}, \"width\": {w} }}\n"),
            )?;
        }
    }
    std::fs::write(
        directory.join("prior.xmp"),
        r#"<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><rdf:Description xmlns:papp="http://ns.justmaple.app/photo/1.0/" xmlns:foreign="urn:removal-fixture" foreign:Keep="untouched"><foreign:History original="preserved"/></rdf:Description></rdf:RDF></x:xmpmeta>"#,
    )?;
    Ok(())
}
