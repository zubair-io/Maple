//! Real sidecars through the writer: a rewritten container whose own tag binds a
//! canonical prefix elsewhere, a correction that shadows a vendor prefix its
//! mask leaf restores, and edits that would move Android's layers across
//! corrections it keeps verbatim or tied with them (`mask_stack`).
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

/// In document order: an Android linear keyed 2, a kept brush keyed 1 and an
/// unkeyed Android radial. The radial has no key, so raw-core reads the
/// document order: linear, brush, radial.
fn partially_keyed() -> Sidecar {
    let stack = android_stack();
    let authored = write(
        &sidecar(EMPTY),
        &[new_layer(stack[0].clone()), new_layer(stack[1].clone())],
    );
    assert!(!authored.contains("LayerOrder"), "{authored}");
    let brush = BRUSH.replace(
        "crs:What=\"Correction\" crs:LocalExposure2012",
        "crs:What=\"Correction\" papp:LayerOrder=\"1\" crs:LocalExposure2012",
    );
    let close = "</crs:GradientBasedCorrections>";
    let mut xml = authored.replacen(close, &format!("{close}{brush}"), 1);
    let linear = xml.find("<crs:GradientBasedCorrections>").unwrap();
    let description = linear + xml[linear..].find("<rdf:Description").unwrap();
    xml.insert_str(
        description + "<rdf:Description".len(),
        " papp:LayerOrder=\"2\"",
    );
    let saved = through_file(&xml);
    assert_stack(&saved);
    saved
}

/// raw-core renders linear, brush, radial.
fn assert_stack(saved: &Sidecar) {
    let stack = rendered(&saved.xml);
    let masks: Vec<&Mask> = stack.iter().map(|layer| &layer.mask).collect();
    assert!(
        matches!(
            masks[..],
            [Mask::Linear { .. }, Mask::Brush { .. }, Mask::Radial { .. }]
        ),
        "{}",
        saved.xml
    );
}

#[test]
fn an_in_place_edit_keeps_a_partially_keyed_stack_in_document_order() {
    let source = partially_keyed();
    let mut layers = read(&source);
    let mut linear = layer_from_json(&layers[0]).unwrap();
    linear.layer.adjustments.exposure = Some(1.25);
    layers[0] = layer_json(&linear);
    let saved = through_file(&write(&source, &layers));
    assert_stack(&saved);
    assert_eq!(rendered(&saved.xml)[0], linear.layer);
    assert!(
        !saved.xml.contains("LayerOrder=\"3\""),
        "the unkeyed radial stays unkeyed: {}",
        saved.xml
    );
}

#[test]
fn removing_the_last_unkeyed_layer_keys_the_stack_in_document_order() {
    let source = partially_keyed();
    let layers = read(&source);
    let saved = through_file(&write(&source, &layers[..1]));
    let stack = rendered(&saved.xml);
    assert_eq!(stack.len(), 2, "{}", saved.xml);
    assert_eq!(stack[0], layer(&layers[0]), "{}", saved.xml);
    assert!(matches!(stack[1].mask, Mask::Brush { .. }), "{}", saved.xml);
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

/// The namespace each vendor element and attribute named `local` resolves to.
fn vendor_names(xml: &str, local: &str) -> Vec<String> {
    let mut reader = NsReader::from_str(xml);
    let mut found = Vec::new();
    loop {
        let (ns, event) = reader.read_resolved_event().unwrap();
        let start = match &event {
            Event::Start(e) | Event::Empty(e) => e,
            Event::Eof => break,
            _ => continue,
        };
        let uri = |ns: ResolveResult| match ns {
            ResolveResult::Bound(ns) => String::from_utf8(ns.0.to_vec()).unwrap(),
            _ => String::new(),
        };
        if start.local_name().into_inner() == local.as_bytes() {
            found.push(uri(ns));
        }
        for attr in start.attributes() {
            let (ns, name) = reader.resolve_attribute(attr.unwrap().key);
            if name.into_inner() == local.as_bytes() {
                found.push(uri(ns));
            }
        }
    }
    found
}

#[test]
fn a_leaf_restoring_a_prefix_its_correction_shadows_keeps_its_namespace() {
    // `f` is urn:vendor on the description, urn:inner on the correction and
    // urn:vendor again on its mask leaf.
    let xml = FOREIGN
        .replacen(" f:Tag=\"sky\"", " xmlns:f=\"urn:inner\" f:Tag=\"sky\"", 1)
        .replacen(
            " f:Leaf=\"top\"/>",
            " xmlns:f=\"urn:vendor\" f:Leaf=\"top\"><f:Mark>kept</f:Mark></rdf:li>",
            1,
        );
    let source = through_file(&xml);
    let expected = [
        ("Tag", "urn:inner"),
        ("Note", "urn:inner"),
        ("Leaf", "urn:vendor"),
        ("Mark", "urn:vendor"),
    ];
    for (local, uri) in expected {
        assert_eq!(vendor_names(&source.xml, local), [uri], "{local}");
    }
    let mut layers = read(&source);
    let mut edited = layer_from_json(&layers[0]).unwrap();
    edited.layer.adjustments.exposure = Some(1.25);
    layers[0] = layer_json(&edited);
    let saved = through_file(&write(&source, &layers));
    for (local, uri) in expected {
        assert_eq!(
            vendor_names(&saved.xml, local),
            [uri],
            "{local} in\n{}",
            saved.xml
        );
    }
    assert_eq!(rendered(&saved.xml)[0], edited.layer, "{}", saved.xml);
}

/// raw-core renders radial, then linear.
fn assert_radial_then_linear(saved: &Sidecar) {
    let stack = rendered(&saved.xml);
    let masks: Vec<&Mask> = stack.iter().map(|layer| &layer.mask).collect();
    assert!(
        matches!(masks[..], [Mask::Radial { .. }, Mask::Linear { .. }]),
        "{}",
        saved.xml
    );
}

#[test]
fn a_brush_container_raw_core_drops_whole_never_unkeys_the_stack() {
    // A linear keyed 2, a radial keyed 1, and an unkeyed brush container one
    // of whose strokes is a brush version this build cannot read.
    let stack = android_stack();
    let mut xml = write(
        &sidecar(EMPTY),
        &[new_layer(stack[0].clone()), new_layer(stack[1].clone())],
    );
    for (container, key) in [
        ("<crs:GradientBasedCorrections>", "2"),
        ("<crs:CircularGradientBasedCorrections>", "1"),
    ] {
        let at = xml.find(container).unwrap();
        let description = at + xml[at..].find("<rdf:Description").unwrap();
        let attribute = format!(" papp:LayerOrder=\"{key}\"");
        xml.insert_str(description + "<rdf:Description".len(), &attribute);
    }
    let item = |brush: &str| {
        let end = brush.rfind("</rdf:li>").unwrap() + "</rdf:li>".len();
        brush[brush.find("<rdf:li>").unwrap()..end].to_owned()
    };
    let unreadable = BRUSH.replace("papp:BrushVersion=\"1\"", "papp:BrushVersion=\"99\"");
    let mixed = BRUSH.replacen(&item(BRUSH), &(item(BRUSH) + &item(&unreadable)), 1);
    let close = "</crs:CircularGradientBasedCorrections>";
    let source = through_file(&xml.replacen(close, &format!("{close}{mixed}"), 1));
    assert_radial_then_linear(&source);

    let mut layers = read(&source);
    let mut linear = layer_from_json(&layers[1]).unwrap();
    assert!(
        matches!(linear.layer.mask, Mask::Linear { .. }),
        "Android lists raw-core's order"
    );
    linear.layer.adjustments.exposure = Some(1.25);
    layers[1] = layer_json(&linear);
    let saved = through_file(&write(&source, &layers));
    assert_radial_then_linear(&saved);
    assert_eq!(rendered(&saved.xml)[1], linear.layer, "{}", saved.xml);
}

#[test]
fn an_edit_keeps_a_layer_tied_with_a_kept_correction_on_its_side_of_it() {
    // A brush and, after it in the document, an Android linear, both keyed 1:
    // raw-core breaks the tie by document order.
    let linear = write(&sidecar(EMPTY), &[new_layer(android_stack()[0].clone())]);
    let keyed = " papp:LayerOrder=\"1\"";
    let brush = BRUSH.replacen("<rdf:Description", &format!("<rdf:Description{keyed}"), 1);
    let open = "<crs:GradientBasedCorrections>";
    let mut xml = linear.replacen(open, &format!("{}\n      {open}", brush.trim_start()), 1);
    let at = xml.find(open).unwrap();
    let description = at + xml[at..].find("<rdf:Description").unwrap() + "<rdf:Description".len();
    xml.insert_str(description, keyed);
    let source = through_file(&xml);
    let masks = |saved: &Sidecar| -> Vec<bool> {
        rendered(&saved.xml)
            .iter()
            .map(|layer| matches!(layer.mask, Mask::Brush { .. }))
            .collect()
    };
    assert_eq!(masks(&source), [true, false], "{}", source.xml);

    let mut layers = read(&source);
    let mut edited = layer_from_json(&layers[0]).unwrap();
    edited.layer.adjustments.exposure = Some(1.25);
    layers[0] = layer_json(&edited);
    let saved = through_file(&write(&source, &layers));
    assert_eq!(masks(&saved), [true, false], "{}", saved.xml);
    assert_eq!(rendered(&saved.xml)[1], edited.layer, "{}", saved.xml);
}
