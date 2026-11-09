use super::merge::{same_properties, three_way};

/// A canonical-layout sidecar: one attribute per line, children at six spaces.
fn doc(attributes: &[(&str, &str)], children: &[&str]) -> String {
    let attributes: String = attributes
        .iter()
        .map(|(key, value)| format!("\n      {key}=\"{value}\""))
        .collect();
    let body: String = children
        .iter()
        .map(|child| format!("\n      {child}"))
        .collect();
    format!(
        "<?xpacket begin=\"\" id=\"W5M0MpCehiHzreSzNTczkc9d\"?>\n<x:xmpmeta xmlns:x=\"adobe:ns:meta/\">\n  <rdf:RDF xmlns:rdf=\"http://www.w3.org/1999/02/22-rdf-syntax-ns#\">\n    <rdf:Description rdf:about=\"\"\n      xmlns:crs=\"http://ns.adobe.com/camera-raw-settings/1.0/\"\n      xmlns:vendor=\"urn:vendor\"{attributes}>{body}\n    </rdf:Description>\n  </rdf:RDF>\n</x:xmpmeta>\n<?xpacket end=\"w\"?>"
    )
}

const FOREIGN: &str =
    "<vendor:Blob>\n        keep   <b>exact</b> &amp; bytes\n      </vendor:Blob>";

#[test]
fn disjoint_changes_from_both_writers_survive() {
    let base = doc(
        &[("crs:Contrast2012", "10"), ("crs:Exposure2012", "0")],
        &[],
    );
    let head = doc(
        &[("crs:Contrast2012", "10"), ("crs:Exposure2012", "1.5")],
        &[],
    );
    let incoming = doc(
        &[("crs:Contrast2012", "40"), ("crs:Exposure2012", "0")],
        &[],
    );
    let merged = three_way(Some(&base), &head, &incoming).unwrap();
    assert_eq!(
        merged,
        doc(
            &[("crs:Contrast2012", "40"), ("crs:Exposure2012", "1.5")],
            &[]
        )
    );
}

#[test]
fn a_property_both_writers_changed_takes_the_incoming_value() {
    let base = doc(&[("crs:Exposure2012", "0")], &[]);
    let head = doc(&[("crs:Exposure2012", "2")], &[]);
    let incoming = doc(&[("crs:Exposure2012", "0.01")], &[]);
    assert_eq!(three_way(Some(&base), &head, &incoming).unwrap(), incoming);
}

#[test]
fn removals_and_additions_apply_from_the_side_that_made_them() {
    let base = doc(&[("crs:Contrast2012", "10"), ("crs:Tint", "5")], &[]);
    // The current document dropped Tint and added a vendor attribute.
    let head = doc(&[("crs:Contrast2012", "10"), ("vendor:Rating", "3")], &[]);
    // The writer dropped Contrast and added Exposure.
    let incoming = doc(&[("crs:Exposure2012", "1"), ("crs:Tint", "5")], &[]);
    let merged = three_way(Some(&base), &head, &incoming).unwrap();
    assert_eq!(
        merged,
        doc(&[("crs:Exposure2012", "1"), ("vendor:Rating", "3")], &[])
    );
}

#[test]
fn new_attributes_follow_the_incoming_order() {
    let base = doc(&[("crs:Contrast2012", "10"), ("crs:Tint", "5")], &[]);
    let head = base.clone();
    let incoming = doc(
        &[
            ("crs:Contrast2012", "10"),
            ("crs:Exposure2012", "1"),
            ("crs:Highlights2012", "-5"),
            ("crs:Tint", "5"),
        ],
        &[],
    );
    assert_eq!(three_way(Some(&base), &head, &incoming).unwrap(), incoming);
}

#[test]
fn unknown_attributes_and_children_keep_the_current_bytes() {
    let base = doc(&[("crs:Exposure2012", "0")], &[FOREIGN]);
    // The current document adds a foreign attribute and rewrites the foreign child.
    let rewritten = "<vendor:Blob>rewritten <i>by another tool</i></vendor:Blob>";
    let head = doc(
        &[("crs:Exposure2012", "0"), ("vendor:Rating", "3")],
        &[rewritten],
    );
    let incoming = doc(&[("crs:Exposure2012", "1")], &[FOREIGN]);
    let merged = three_way(Some(&base), &head, &incoming).unwrap();
    assert_eq!(
        merged,
        doc(
            &[("crs:Exposure2012", "1"), ("vendor:Rating", "3")],
            &[rewritten]
        )
    );
    // Nothing the writer did not touch was re-encoded: the head's foreign
    // bytes are present verbatim.
    assert!(merged.contains(rewritten));
}

#[test]
fn child_elements_merge_by_name_and_expand_a_self_closing_description() {
    let base = "<x:xmpmeta xmlns:x=\"adobe:ns:meta/\"><rdf:RDF xmlns:rdf=\"http://www.w3.org/1999/02/22-rdf-syntax-ns#\"><rdf:Description rdf:about=\"\" xmlns:crs=\"http://ns.adobe.com/camera-raw-settings/1.0/\" xmlns:vendor=\"urn:vendor\" crs:Exposure2012=\"0\" /></rdf:RDF></x:xmpmeta>";
    let head = base.replace("\"0\"", "\"3\"");
    let incoming = base.replace(
        " /></rdf:RDF>",
        ">\n      <vendor:Blob>new child</vendor:Blob>\n    </rdf:Description></rdf:RDF>",
    );
    let merged = three_way(Some(base), &head, &incoming).unwrap();
    assert!(merged.contains("crs:Exposure2012=\"3\""));
    assert!(merged.contains("<vendor:Blob>new child</vendor:Blob>"));
    assert!(merged.ends_with("</rdf:Description></rdf:RDF></x:xmpmeta>"));
    let record = crate::xmp::parse(&merged).unwrap();
    assert_eq!(record.exposure, 3.0);
}

#[test]
fn an_absent_base_is_a_document_with_no_properties() {
    let head = doc(&[("crs:Exposure2012", "2")], &[FOREIGN]);
    let incoming = doc(&[("crs:Contrast2012", "30")], &[]);
    let merged = three_way(None, &head, &incoming).unwrap();
    assert_eq!(
        merged,
        doc(
            &[("crs:Contrast2012", "30"), ("crs:Exposure2012", "2")],
            &[FOREIGN]
        )
    );
}

#[test]
fn same_properties_ignores_attribute_order_and_layout() {
    let a = doc(&[("crs:Contrast2012", "10"), ("crs:Tint", "5")], &[FOREIGN]);
    let b = doc(&[("crs:Tint", "5"), ("crs:Contrast2012", "10")], &[FOREIGN]);
    assert!(same_properties(Some(&a), &b).unwrap());
    assert!(!same_properties(Some(&a), &b.replace("\"10\"", "\"11\"")).unwrap());
    assert!(!same_properties(None, &a).unwrap());
}

#[test]
fn a_merge_that_strands_a_prefix_fails_instead_of_producing_a_broken_sidecar() {
    let with_dc = |extra: &[(&str, &str)]| {
        let mut attributes = vec![("xmlns:dc", "http://purl.org/dc/elements/1.1/")];
        attributes.extend_from_slice(extra);
        doc(&attributes, &[])
    };
    let base = with_dc(&[("dc:title", "a")]);
    // The current document dropped both the declaration and its attribute…
    let head = doc(&[], &[]);
    // …while the writer changed the attribute that now has no declaration.
    let incoming = with_dc(&[("dc:title", "b")]);
    assert!(three_way(Some(&base), &head, &incoming).is_err());
}
