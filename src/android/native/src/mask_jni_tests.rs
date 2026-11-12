//! Real sidecar files through the mask entries. The helpers stand in for the
//! Kotlin lexical reader/writer: they cut the primary description's mask
//! containers out with their namespace scope, and splice the result back.
use super::*;
use crate::mask_document::CONTAINERS;
use crate::mask_xml::canonical_name;
use quick_xml::events::Event;
use quick_xml::name::{PrefixDeclaration, ResolveResult};
use quick_xml::NsReader;
use raw_core::types::{
    LocalAdjustment, Mask, MaskCombine, MaskComponent, MaskGroup, PartialAdjustments, Point2,
    SKIN_TONE_RANGE,
};
use serde_json::{json, Value};
use std::ffi::CStr;
use std::ops::Range;

const INDENT: &str = "      ";
const EMPTY: &str = "<?xpacket begin=\"\" id=\"W5M0MpCehiHzreSzNTczkc9d\"?>\n<x:xmpmeta xmlns:x=\"adobe:ns:meta/\">\n  <rdf:RDF xmlns:rdf=\"http://www.w3.org/1999/02/22-rdf-syntax-ns#\">\n    <rdf:Description rdf:about=\"\"\n      xmlns:crs=\"http://ns.adobe.com/camera-raw-settings/1.0/\"\n      xmlns:papp=\"http://ns.justmaple.app/photo/1.0/\"\n      xmlns:f=\"urn:vendor\"\n      crs:Exposure2012=\"0.4\" f:Kept=\"yes\">\n      <f:Note>outside every mask</f:Note>\n    </rdf:Description>\n  </rdf:RDF>\n</x:xmpmeta>\n<?xpacket end=\"w\"?>";

struct Sidecar {
    xml: String,
    spans: Vec<Range<usize>>,
    close: usize,
    input: Value,
}

fn scope(reader: &NsReader<&[u8]>) -> Value {
    Value::Object(
        reader
            .prefixes()
            .map(|(prefix, ns)| {
                let prefix = match prefix {
                    PrefixDeclaration::Default => String::new(),
                    PrefixDeclaration::Named(p) => String::from_utf8(p.to_vec()).unwrap(),
                };
                (prefix, json!(String::from_utf8(ns.0.to_vec()).unwrap()))
            })
            .collect(),
    )
}

fn sidecar(xml: &str) -> Sidecar {
    let mut reader = NsReader::from_str(xml);
    let (mut depth, mut spans, mut containers, mut close) = (0, Vec::new(), Vec::new(), 0);
    let (mut description_depth, mut open, mut target) = (0, None, json!({}));
    loop {
        let before = reader.buffer_position() as usize;
        let (namespace, event) = reader.read_resolved_event().unwrap();
        let uri = match namespace {
            ResolveResult::Bound(ns) => Some(String::from_utf8(ns.0.to_vec()).unwrap()),
            _ => None,
        };
        let after = reader.buffer_position() as usize;
        let (start, empty) = match &event {
            Event::Start(e) => (Some(e), false),
            Event::Empty(e) => (Some(e), true),
            _ => (None, false),
        };
        if let Some(e) = start {
            let local = String::from_utf8(e.local_name().into_inner().to_vec()).unwrap();
            let name = canonical_name(uri.as_deref(), &local);
            if name.as_deref() == Some("rdf:Description") && depth == 2 {
                description_depth = depth + 1;
                target = scope(&reader);
            } else if depth == description_depth
                && name.as_deref().is_some_and(|n| CONTAINERS.contains(&n))
            {
                open = Some((before, scope(&reader)));
            }
            if !empty {
                depth += 1;
            } else if open.as_ref().is_some_and(|(at, _)| *at == before) {
                let (at, scope) = open.take().unwrap();
                spans.push(at..after);
                containers.push(json!({"scope": scope, "xml": &xml[at..after]}));
            }
        }
        match event {
            Event::End(_) => {
                depth -= 1;
                if depth == description_depth {
                    if let Some((start, scope)) = open.take() {
                        spans.push(start..after);
                        containers.push(json!({"scope": scope, "xml": &xml[start..after]}));
                    }
                }
                if depth + 1 == description_depth {
                    close = xml[..before].trim_end().len();
                    description_depth = 0;
                }
            }
            Event::Eof => break,
            _ => {}
        }
    }
    let input = json!({"target": target, "containers": containers, "indent": INDENT});
    Sidecar {
        xml: xml.to_owned(),
        spans,
        close,
        input,
    }
}

fn call(entry: unsafe extern "C" fn(*const c_char) -> *mut c_char, input: &Value) -> Value {
    let input = CString::new(input.to_string()).unwrap();
    let raw = unsafe { entry(input.as_ptr()) };
    assert!(
        !raw.is_null(),
        "{}",
        unsafe { CStr::from_ptr(crate::maple_android_error()) }
            .to_str()
            .unwrap()
    );
    let text = unsafe { CStr::from_ptr(raw) }.to_str().unwrap().to_owned();
    unsafe { crate::maple_android_free_string(raw) };
    serde_json::from_str(&text).unwrap()
}

fn read(document: &Sidecar) -> Vec<Value> {
    call(maple_android_masks_read, &document.input)["layers"]
        .as_array()
        .unwrap()
        .clone()
}

/// Writes `layers` and splices the result the way `XmpDocument` does.
fn write(document: &Sidecar, layers: &[Value]) -> String {
    let mut input = document.input.clone();
    input["layers"] = json!(layers);
    let output = call(maple_android_masks_write, &input);
    let appended: String = output["appended"]
        .as_array()
        .unwrap()
        .iter()
        .map(|container| format!("\n{INDENT}{}", container.as_str().unwrap()))
        .collect();
    let mut xml = document.xml.clone();
    xml.insert_str(document.close, &appended);
    for (span, replacement) in document
        .spans
        .iter()
        .zip(output["containers"].as_array().unwrap())
        .rev()
    {
        let replacement = replacement.as_str().unwrap();
        let start = if replacement.is_empty() {
            xml[..span.start].trim_end().len()
        } else {
            span.start
        };
        xml.replace_range(start..span.end, replacement);
    }
    xml
}

/// Persists `xml` as a sidecar and reads it back from disk.
fn through_file(xml: &str) -> Sidecar {
    let path = std::env::temp_dir().join(format!(
        "android-masks-{}-{}.xmp",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    std::fs::write(&path, xml).unwrap();
    let back = std::fs::read_to_string(&path).unwrap();
    std::fs::remove_file(path).unwrap();
    sidecar(&back)
}

fn rendered(xml: &str) -> Vec<LocalAdjustment> {
    raw_core::xmp::parse_namespaced(xml)
        .unwrap()
        .local_adjustments
}

fn layer(value: &Value) -> LocalAdjustment {
    crate::mask_model::layer_from_json(value).unwrap().layer
}

fn new_layer(layer: LocalAdjustment) -> Value {
    let sources = vec![
        None;
        if let Mask::Group(g) = &layer.mask {
            g.components.len()
        } else {
            1
        }
    ];
    crate::mask_model::layer_json(&crate::mask_model::AuthoredLayer {
        layer,
        slot: None,
        sources,
    })
}

fn android_stack() -> Vec<LocalAdjustment> {
    let linear = LocalAdjustment::linear(
        Point2::new(0.25, 0.75),
        Point2::new(0.25, 0.25),
        PartialAdjustments {
            exposure: Some(-0.75),
            ..Default::default()
        },
    );
    let mut radial = LocalAdjustment::radial(
        Point2::new(0.5, 0.5),
        Point2::new(0.25, 0.125),
        PartialAdjustments {
            saturation: Some(30.0),
            temperature: Some(-500.0),
            ..Default::default()
        },
    );
    radial.range = Some(SKIN_TONE_RANGE);
    if let Mask::Radial { invert, .. } = &mut radial.mask {
        *invert = true;
    }
    let group = LocalAdjustment {
        mask: Mask::Group(MaskGroup {
            components: vec![
                MaskComponent::new(radial.mask.clone(), MaskCombine::Add, false).unwrap(),
                MaskComponent::new(linear.mask.clone(), MaskCombine::Subtract, true).unwrap(),
            ],
            opacity: 1.0,
            invert: false,
        }),
        range: None,
        adjustments: PartialAdjustments {
            clarity: Some(25.0),
            ..Default::default()
        },
    };
    vec![linear, radial, group]
}

#[test]
fn android_layers_write_raw_core_canonical_xml_and_read_back_from_disk() {
    let stack = android_stack();
    let empty = sidecar(EMPTY);
    assert!(read(&empty).is_empty());
    let authored = write(
        &empty,
        &stack.iter().cloned().map(new_layer).collect::<Vec<_>>(),
    );
    let model = AdjustmentModel {
        local_adjustments: stack.clone(),
        ..Default::default()
    };
    let canonical = raw_core::xmp::serialize_local_adjustments(&model, INDENT);
    assert!(authored.contains(&canonical), "{authored}");
    assert_eq!(authored.replacen(&format!("\n{canonical}"), "", 1), EMPTY);
    let saved = through_file(&authored);
    assert_eq!(rendered(&saved.xml), stack);
    let layers = read(&saved);
    assert_eq!(layers.iter().map(layer).collect::<Vec<_>>(), stack);
    assert_eq!(
        write(&saved, &layers),
        saved.xml,
        "an unchanged stack keeps its bytes"
    );
}

#[test]
fn interleaved_layers_are_keyed_and_read_back_in_model_order() {
    let stack: Vec<_> = android_stack().into_iter().rev().collect();
    let empty = sidecar(EMPTY);
    let authored = write(
        &empty,
        &stack.iter().cloned().map(new_layer).collect::<Vec<_>>(),
    );
    let model = AdjustmentModel {
        local_adjustments: stack.clone(),
        ..Default::default()
    };
    assert!(authored.contains(&raw_core::xmp::serialize_local_adjustments(&model, INDENT)));
    assert!(authored.contains("papp:LayerOrder=\"2\""));
    let saved = through_file(&authored);
    assert_eq!(rendered(&saved.xml), stack);
    assert_eq!(read(&saved).iter().map(layer).collect::<Vec<_>>(), stack);
}

fn fixture(path: &str) -> String {
    std::fs::read_to_string(std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join(path)).unwrap()
}

#[test]
fn lightroom_and_apple_sidecars_keep_foreign_bytes_and_metadata_through_edits() {
    for path in [
        "../../../test-fixtures/local-adjustments/lightroom-group-add.xmp",
        "../../../test-fixtures/local-adjustments/lightroom-group-subtract.xmp",
        "../../../test-fixtures/local-adjustments/lightroom-group-intersect.xmp",
        "../../../test-fixtures/local-adjustments/spatial-radial.xmp",
        "../../apple/MapleUITests/Fixtures/sidecar/test_0017-masks.xmp",
    ] {
        let source = through_file(&fixture(path));
        let layers = read(&source);
        let expected = rendered(&source.xml);
        assert!(!layers.is_empty(), "{path}");
        assert_eq!(
            layers.iter().map(layer).collect::<Vec<_>>(),
            expected,
            "{path}"
        );
        assert_eq!(
            write(&source, &layers),
            source.xml,
            "{path}: unchanged layers keep their bytes"
        );

        let mut edited = layers.clone();
        edited[0]["adjustments"]["exposure"] = json!(1.25);
        let saved = through_file(&write(&source, &edited));
        let first = source.spans[0].start;
        let last = source.spans.last().unwrap().end;
        assert_eq!(
            &saved.xml[..first],
            &source.xml[..first],
            "{path}: bytes before the masks"
        );
        assert_eq!(
            &saved.xml[saved.xml.len() - (source.xml.len() - last)..],
            &source.xml[last..],
            "{path}: bytes after the masks"
        );
        let mut want = expected.clone();
        want[0].adjustments.exposure = Some(1.25);
        assert_eq!(rendered(&saved.xml), want, "{path}");
        for name in [
            "crs:CorrectionName=\"Composition reference\"",
            "crs:MaskName=\"Radial reference\"",
            "crs:LocalCurveRefineSaturation=\"100\"",
        ] {
            if source.xml.contains(name) {
                assert!(
                    saved.xml.contains(name),
                    "{path}: {name} travels with its correction"
                );
            }
        }
        let mut again = read(&saved);
        again[0]["adjustments"]["exposure"] = json!(-0.5);
        let twice = write(&saved, &again);
        for name in ["crs:CorrectionSyncID=", "crs:MaskSyncID="] {
            assert_eq!(
                twice.matches(name).count(),
                source.xml.matches(name).count(),
                "{path}: {name}"
            );
        }
    }
}

const FOREIGN: &str = r#"<?xpacket begin="" id="W5M0MpCehiHzreSzNTczkc9d"?>
<x:xmpmeta xmlns:x="adobe:ns:meta/">
 <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
  <rdf:Description rdf:about="" xmlns:crs="http://ns.adobe.com/camera-raw-settings/1.0/" xmlns:f="urn:vendor" crs:Version="18.7">
   <crs:GradientBasedCorrections>
    <rdf:Seq>
     <rdf:li>
      <rdf:Description crs:What="Correction" crs:CorrectionAmount="0.5" crs:CorrectionActive="true" f:Tag="sky" crs:LocalExposure2012="1">
       <f:Note>graded by hand</f:Note>
       <crs:CorrectionMasks>
        <rdf:Seq>
         <rdf:li crs:What="Mask/Gradient" crs:MaskValue="1" crs:ZeroX="0.5" crs:ZeroY="0" crs:FullX="0.5" crs:FullY="0.5" f:Leaf="top"/>
        </rdf:Seq>
       </crs:CorrectionMasks>
      </rdf:Description>
     </rdf:li>
     <rdf:li>
      <rdf:Description crs:What="Correction" crs:CorrectionActive="false" crs:LocalExposure2012="-1">
       <crs:CorrectionMasks><rdf:Seq><rdf:li crs:What="Mask/Gradient" crs:ZeroX="0" crs:ZeroY="0" crs:FullX="1" crs:FullY="1"/></rdf:Seq></crs:CorrectionMasks>
      </rdf:Description>
     </rdf:li>
    </rdf:Seq>
   </crs:GradientBasedCorrections>
   <crs:MaskGroupBasedCorrections>
    <rdf:Seq>
     <rdf:li>
      <rdf:Description crs:What="Correction" crs:CorrectionActive="true" crs:LocalExposure2012="0.3">
       <crs:CorrectionMasks><rdf:Seq><rdf:li crs:What="Mask/Image" crs:MaskDigest="ABCDEF" crs:MaskValue="1"/></rdf:Seq></crs:CorrectionMasks>
      </rdf:Description>
     </rdf:li>
    </rdf:Seq>
   </crs:MaskGroupBasedCorrections>
  </rdf:Description>
 </rdf:RDF>
</x:xmpmeta>"#;

#[test]
fn unknown_metadata_and_unmodelled_corrections_survive_conversion_and_deletion() {
    let source = through_file(FOREIGN);
    let layers = read(&source);
    assert_eq!(
        layers.len(),
        1,
        "the inactive and AI corrections are not Android's to edit"
    );
    assert_eq!(
        layer(&layers[0]).adjustments.exposure,
        Some(0.5),
        "amount 0.5 is applied"
    );
    let inactive = &FOREIGN[FOREIGN.find("     <rdf:li>\n      <rdf:Description crs:What=\"Correction\" crs:CorrectionActive=\"false\"").unwrap()..];
    let inactive = &inactive[..inactive.find("</rdf:li>").unwrap() + 9];
    let ai = &FOREIGN[FOREIGN.find("<rdf:Description crs:What=\"Correction\" crs:CorrectionActive=\"true\" crs:LocalExposure2012=\"0.3\"").unwrap()..];
    let ai = &ai[..ai.find("</rdf:Description>").unwrap()];

    let mut grouped = layers[0].clone();
    let leaf = grouped["mask"].clone();
    grouped["mask"] = json!({"kind": "group", "opacity": 1.0, "invert": false, "components": [
        {"combine": "Add", "invert": false, "source": 0, "mask": leaf},
        {"combine": "Intersect", "invert": false, "source": null,
         "mask": {"kind": "radial", "center": [0.5, 0.5], "radii": [0.3, 0.3], "angle": 0.0, "feather": 0.5, "invert": false}},
    ]});
    let converted = through_file(&write(&source, &[grouped]));
    for kept in [
        inactive,
        ai,
        "f:Tag=\"sky\"",
        "<f:Note>graded by hand</f:Note>",
        "f:Leaf=\"top\"",
    ] {
        assert!(converted.xml.contains(kept), "{kept} in\n{}", converted.xml);
    }
    let group_container = &converted.xml[converted
        .xml
        .find("<crs:MaskGroupBasedCorrections")
        .unwrap()..];
    assert!(
        group_container.contains("f:Tag=\"sky\""),
        "metadata moved with its layer"
    );
    let model = rendered(&converted.xml);
    assert_eq!(model.len(), 1);
    assert!(matches!(&model[0].mask, Mask::Group(g) if g.components.len() == 2));
    let read_back = read(&converted);
    assert_eq!(layer(&read_back[0]), model[0]);

    let deleted = through_file(&write(&converted, &[]));
    assert!(deleted.xml.contains(inactive) && deleted.xml.contains(ai));
    assert!(!deleted.xml.contains("f:Tag") && !deleted.xml.contains("f:Note"));
    assert!(read(&deleted).is_empty());
}

#[test]
fn keys_of_corrections_kept_verbatim_stay_stable() {
    let keyed = EMPTY.replace(
        "      <f:Note>",
        "      <papp:BrushCorrections>\n        <rdf:Seq>\n          <rdf:li>\n            <rdf:Description crs:What=\"Correction\" papp:LayerOrder=\"1\">\n              <crs:CorrectionMasks><rdf:Seq><rdf:li crs:What=\"Mask/Paint\" papp:BrushVersion=\"99\"/></rdf:Seq></crs:CorrectionMasks>\n            </rdf:Description>\n          </rdf:li>\n        </rdf:Seq>\n      </papp:BrushCorrections>\n      <f:Note>",
    );
    let source = sidecar(&keyed);
    let stack = android_stack();
    let first = through_file(&write(&source, &[new_layer(stack[0].clone())]));
    assert!(first.xml.contains("papp:LayerOrder=\"0\""), "{}", first.xml);
    let mut layers = read(&first);
    layers.push(new_layer(stack[1].clone()));
    let second = through_file(&write(&first, &layers));
    assert!(
        second.xml.contains("papp:LayerOrder=\"0\"")
            && second.xml.contains("papp:LayerOrder=\"0.5\"")
    );
    assert!(
        second.xml.contains("papp:BrushVersion=\"99\"")
            && second.xml.contains("papp:LayerOrder=\"1\"")
    );
    assert_eq!(
        read(&second).iter().map(layer).collect::<Vec<_>>(),
        stack[..2].to_vec()
    );
}

#[test]
fn mask_weights_come_from_the_render_evaluator() {
    let radial = new_layer(android_stack()[1].clone());
    let text = CString::new(radial.to_string()).unwrap();
    let mut out = vec![0u8; 9 * 9];
    assert!(unsafe { maple_android_mask_weights(text.as_ptr(), 9, 9, out.as_mut_ptr()) });
    let mask = layer(&radial).mask;
    for (index, weight) in out.iter().enumerate() {
        let w = evaluate(
            &mask,
            None,
            (index % 9) as f32 / 8.0,
            (index / 9) as f32 / 8.0,
        );
        assert_eq!(*weight, (w * 255.0).round() as u8);
    }
    assert_eq!(out[4 * 9 + 4], 0, "inverted radial is empty at its centre");
    assert_eq!(out[0], 255);
    assert!(!unsafe { maple_android_mask_weights(text.as_ptr(), 1, 9, out.as_mut_ptr()) });
}

#[test]
fn the_crop_frame_maps_the_presented_crop_onto_the_full_frame() {
    let mut out = [0.0; 6];
    assert!(unsafe {
        maple_android_mask_frame(400, 300, 0.0, 0.0, 1.0, 1.0, 0.0, out.as_mut_ptr())
    });
    assert_eq!(out, [1.0, 0.0, 0.0, 0.0, 1.0, 0.0]);
    assert!(unsafe {
        maple_android_mask_frame(400, 300, 0.2, 0.25, 0.8, 0.75, 0.0, out.as_mut_ptr())
    });
    for (got, want) in out.iter().zip([0.5, 0.0, 0.25, 0.0, 0.6, 0.2]) {
        assert!((got - want).abs() < 1e-6, "{out:?}");
    }
    let tilted = crop_to_frame(
        400,
        300,
        Crop {
            top: 0.1,
            left: 0.1,
            bottom: 0.9,
            right: 0.9,
            angle: 10.0,
        },
    );
    let centre = (
        tilted[0] * 0.5 + tilted[1] * 0.5 + tilted[2],
        tilted[3] * 0.5 + tilted[4] * 0.5 + tilted[5],
    );
    assert!(
        (centre.0 - 0.5).abs() < 1e-3 && (centre.1 - 0.5).abs() < 1e-3,
        "{tilted:?}"
    );
    assert!(
        tilted[1].abs() > 1e-3,
        "a straightened crop rotates the frame"
    );
}

#[test]
fn the_eyedropper_seeds_from_raw_core_and_refuses_neutral_or_outside_points() {
    let dng = raw_core::test_support::synth_dng::SyntheticGreyDng::default().write_to_bytes();
    let raw = Arc::new(raw_core::decode::decode_bytes(&dng, "dng").unwrap());
    let neutral = MaskRangeWork::new(Arc::clone(&raw), EMPTY).unwrap();
    let refused: Value = serde_json::from_str(&neutral.run(0.5, 0.5).unwrap()).unwrap();
    assert!(
        refused["refused"]
            .as_str()
            .unwrap()
            .starts_with("Sampled surface is neutral"),
        "{refused}"
    );
    let outside: Value = serde_json::from_str(&neutral.run(1.5, 0.5).unwrap()).unwrap();
    assert!(
        outside["refused"].as_str().unwrap().contains("outside"),
        "{outside}"
    );
    let warm = EMPTY.replace("crs:Exposure2012=\"0.4\"", "crs:Exposure2012=\"1\" crs:Temperature=\"12000\" crs:Tint=\"60\" crs:WhiteBalance=\"Custom\"");
    let coloured: Value = serde_json::from_str(
        &MaskRangeWork::new(raw, &warm)
            .unwrap()
            .run(0.5, 0.5)
            .unwrap(),
    )
    .unwrap();
    let seed = &coloured["seed"];
    assert!(seed["hue_deg"].as_f64().unwrap().is_finite(), "{coloured}");
    assert!(seed["l_min"].as_f64().unwrap() < seed["l_max"].as_f64().unwrap());
}
