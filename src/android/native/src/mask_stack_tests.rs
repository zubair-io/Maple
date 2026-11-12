//! Real sidecars through the writer: a rewritten container whose own tag binds a
//! canonical prefix elsewhere, and edits that would move Android's layers across
//! corrections it keeps verbatim (`mask_stack`).
use super::*;
use crate::mask_model::{layer_from_json, layer_json, AuthoredLayer};

const BRUSH: &str = "\n      <papp:BrushCorrections>\n        <rdf:Seq>\n          <rdf:li>\n            <rdf:Description crs:What=\"Correction\" crs:LocalExposure2012=\"0.5\">\n              <crs:CorrectionMasks><rdf:Seq><rdf:li crs:What=\"Mask/Paint\" papp:BrushVersion=\"1\" papp:Dabs=\"0.5 0.5 0.05 0.5 1 0\"/></rdf:Seq></crs:CorrectionMasks>\n            </rdf:Description>\n          </rdf:li>\n        </rdf:Seq>\n      </papp:BrushCorrections>";

/// An unkeyed Android linear followed by an unkeyed brush Android keeps verbatim.
fn linear_then_brush(brush_tag: &str) -> Sidecar {
    let linear = write(&sidecar(EMPTY), &[new_layer(android_stack()[0].clone())]);
    assert!(!linear.contains("LayerOrder"), "{linear}");
    let brush = BRUSH.replace("<papp:BrushCorrections>", brush_tag);
    let close = "</crs:GradientBasedCorrections>";
    let xml = linear.replacen(close, &format!("{close}{brush}"), 1);
    let saved = through_file(&xml);
    let stack = rendered(&saved.xml);
    assert_eq!(stack.len(), 2, "raw-core models both corrections");
    assert!(matches!(stack[0].mask, Mask::Linear { .. }));
    saved
}

/// The linear grown into a group with a radial: it moves to the group container.
fn grouped(source: &Sidecar) -> Value {
    let read = layer_from_json(&read(source)[0]).unwrap();
    let radial = android_stack()[1].mask.clone();
    let layer = LocalAdjustment {
        mask: Mask::Group(MaskGroup {
            components: vec![
                MaskComponent::new(read.layer.mask.clone(), MaskCombine::Add, false).unwrap(),
                MaskComponent::new(radial, MaskCombine::Add, false).unwrap(),
            ],
            opacity: 1.0,
            invert: false,
        }),
        ..read.layer.clone()
    };
    layer_json(&AuthoredLayer {
        layer,
        slot: read.slot,
        sources: vec![Some(0), None],
    })
}

#[test]
fn moving_a_layer_past_an_unkeyed_kept_correction_keys_the_whole_stack() {
    let source = linear_then_brush("<papp:BrushCorrections>");
    let edited = grouped(&source);
    let saved = through_file(&write(&source, std::slice::from_ref(&edited)));
    let stack = rendered(&saved.xml);
    assert_eq!(stack.len(), 2, "{}", saved.xml);
    assert_eq!(
        stack[0],
        layer(&edited),
        "the group keeps the linear's place"
    );
    assert!(matches!(stack[1].mask, Mask::Brush { .. }), "{}", saved.xml);
    assert!(saved.xml.contains("papp:Dabs=\"0.5 0.5 0.05 0.5 1 0\""));
    assert!(
        saved.xml.contains("papp:LayerOrder=\"0\"") && saved.xml.contains("papp:LayerOrder=\"1\"")
    );
    assert_eq!(
        read(&saved).iter().map(layer).collect::<Vec<_>>(),
        vec![layer(&edited)]
    );
}

#[test]
fn an_edit_that_keeps_document_order_leaves_kept_corrections_unkeyed() {
    let source = linear_then_brush("<papp:BrushCorrections>");
    let mut layers = read(&source);
    let mut linear = layer_from_json(&layers[0]).unwrap();
    linear.layer.adjustments.exposure = Some(1.25);
    layers[0] = layer_json(&linear);
    let saved = through_file(&write(&source, &layers));
    assert!(!saved.xml.contains("LayerOrder"), "{}", saved.xml);
    assert_eq!(rendered(&saved.xml)[0], linear.layer);
}

#[test]
fn a_move_past_a_correction_android_cannot_key_is_refused() {
    let source = linear_then_brush("<papp:BrushCorrections f:Tag=\"opaque\">");
    let mut input = source.input.clone();
    input["layers"] = json!([grouped(&source)]);
    let refused = crate::mask_write::write(&input).unwrap_err();
    assert!(refused.contains("cannot rewrite"), "{refused}");
}

#[test]
fn a_container_binding_a_canonical_prefix_elsewhere_is_never_declared_twice() {
    let authored = write(&sidecar(EMPTY), &[new_layer(android_stack()[0].clone())]);
    let open = "<crs:GradientBasedCorrections>";
    let at = authored.find(open).unwrap();
    let end = at
        + authored[at..]
            .find("</crs:GradientBasedCorrections>")
            .unwrap();
    let foreign = [
        // papp bound to Maple's legacy namespace on the container itself.
        authored[at..end].replacen(
            open,
            "<crs:GradientBasedCorrections xmlns:papp=\"http://ns.justmaple.app/1.0/\">",
            1,
        ) + "</crs:GradientBasedCorrections>",
        // Adobe's settings under another prefix, `crs` bound to a vendor.
        authored[at..end].replace("crs:", "acr:").replacen(
            "<acr:GradientBasedCorrections>",
            "<acr:GradientBasedCorrections xmlns:acr=\"http://ns.adobe.com/camera-raw-settings/1.0/\" xmlns:crs=\"urn:vendor:crs\">",
            1,
        ) + "</acr:GradientBasedCorrections>",
    ];
    for container in foreign {
        let close = authored[end..].find('>').unwrap() + end + 1;
        let xml = format!("{}{container}{}", &authored[..at], &authored[close..]);
        let source = through_file(&xml);
        let mut layers = read(&source);
        let mut linear = layer_from_json(&layers[0]).unwrap();
        linear.layer.adjustments.exposure = Some(1.25);
        layers[0] = layer_json(&linear);
        let saved = write(&source, &layers);
        let tag_at = saved.find("GradientBasedCorrections").unwrap();
        let tag = &saved[tag_at..tag_at + saved[tag_at..].find('>').unwrap()];
        for prefix in ["xmlns:papp=", "xmlns:crs=", "xmlns:acr="] {
            assert!(tag.matches(prefix).count() <= 1, "{tag}");
        }
        let saved = through_file(&saved);
        assert_eq!(
            rendered(&saved.xml),
            vec![linear.layer.clone()],
            "{}",
            saved.xml
        );
    }
}
