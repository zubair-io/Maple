use super::*;

const XMP: &str = include_str!(concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../../../test-fixtures/local-adjustments/lightroom-group-add.xmp"
));
fn workflow() -> SidecarWorkflow {
    let json = include_str!(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../../test-fixtures/workflow/contract-v1.json"
    ));
    let rows: Vec<serde_json::Value> = serde_json::from_str(json).unwrap();
    SidecarWorkflow::parse(&rows[1].to_string()).unwrap()
}

#[test]
fn checkpoint_removes_only_validated_owned_region_and_preserves_exact_foreign_bytes() {
    let source = XMP.replace(
        "<crs:MaskGroupBasedCorrections>",
        "<vendor:Workflow xmlns:vendor=\"urn:foreign\">keep &amp; preserve</vendor:Workflow>\r\n<crs:MaskGroupBasedCorrections>",
    );
    assert_eq!(SidecarWorkflow::checkpoint_xmp(&source).unwrap(), source);
    let embedded = workflow().embed_in_xmp(&source).unwrap();
    let start = embedded.find("<papp:Workflow").unwrap();
    let end = embedded.find("</papp:Workflow>").unwrap() + "</papp:Workflow>".len();
    let expected = format!("{}{}", &embedded[..start], &embedded[end..]);
    let checkpoint = SidecarWorkflow::checkpoint_xmp(&embedded).unwrap();
    assert_eq!(checkpoint.as_bytes(), expected.as_bytes());
    assert_eq!(SidecarWorkflow::from_xmp(&checkpoint).unwrap(), None);
    assert_eq!(
        crate::xmp::parse(&checkpoint).unwrap(),
        crate::xmp::parse(&source).unwrap()
    );
    assert!(checkpoint.contains("keep &amp; preserve</vendor:Workflow>\r\n"));
    let dir = tempfile::tempdir().unwrap();
    let original = dir.path().join("photo.dng");
    let sidecar = dir
        .path()
        .join(super::variant_filename("photo.xmp", &workflow().variant_id).unwrap());
    std::fs::write(&original, [1, 0, 255, 42]).unwrap();
    std::fs::write(&sidecar, &checkpoint).unwrap();
    let reopened = std::fs::read_to_string(sidecar).unwrap();
    assert_eq!(
        SidecarWorkflow::checkpoint_xmp(&reopened).unwrap(),
        checkpoint
    );
    assert_eq!(std::fs::read(original).unwrap(), [1, 0, 255, 42]);
}

#[test]
fn checkpoint_capture_refuses_future_malformed_or_rebound_owned_content() {
    let embedded = workflow().embed_in_xmp(XMP).unwrap();
    for xml in [
        embedded.replace("<papp:SchemaVersion>1", "<papp:SchemaVersion>2"),
        embedded.replace("<papp:VariantId>", "<papp:UnknownId>"),
        embedded.replace("http://ns.justmaple.app/photo/1.0/", "urn:future"),
        embedded
            .replace("papp:Workflow", "alias:Workflow")
            .replace("xmlns:papp=", "xmlns:alias="),
        "not xml".into(),
        format!("<!DOCTYPE x:xmpmeta [<!ENTITY x 'bad'>]>{XMP}"),
    ] {
        let before = xml.clone();
        assert!(SidecarWorkflow::checkpoint_xmp(&xml).is_err());
        assert_eq!(xml, before);
    }
}

#[test]
fn complete_record_survives_real_sidecar_write_reopen_without_touching_original() {
    let dir = tempfile::tempdir().unwrap();
    let original = dir.path().join("photo.dng");
    let sidecar = dir.path().join("photo.xmp");
    let original_bytes = [1_u8, 2, 99, 255, 0];
    std::fs::write(&original, original_bytes).unwrap();
    std::fs::write(&sidecar, XMP).unwrap();
    let input = std::fs::read_to_string(&sidecar).unwrap();
    let record = workflow();
    let embedded = record.embed_in_xmp(&input).unwrap();
    std::fs::write(&sidecar, &embedded).unwrap();
    let reopened = std::fs::read_to_string(&sidecar).unwrap();
    assert_eq!(
        SidecarWorkflow::from_xmp(&reopened).unwrap(),
        Some(record.clone())
    );
    assert_eq!(record.embed_in_xmp(&reopened).unwrap(), reopened);
    assert_eq!(
        crate::xmp::parse(&reopened).unwrap(),
        crate::xmp::parse(XMP).unwrap()
    );
    let foreign = XMP
        .split("<crs:MaskGroupBasedCorrections>")
        .nth(1)
        .unwrap()
        .split("</crs:MaskGroupBasedCorrections>")
        .next()
        .unwrap();
    assert!(reopened.contains(foreign));
    assert_eq!(std::fs::read(original).unwrap(), original_bytes);
}

#[test]
fn missing_workflow_is_explicit_and_self_closing_description_expands() {
    let xml = "<x:xmpmeta xmlns:x=\"adobe:ns:meta/\"><rdf:RDF xmlns:rdf=\"http://www.w3.org/1999/02/22-rdf-syntax-ns#\"><rdf:Description xmlns:crs=\"http://ns.adobe.com/camera-raw-settings/1.0/\" crs:Exposure2012=\"0.25\" /></rdf:RDF></x:xmpmeta>";
    assert_eq!(SidecarWorkflow::from_xmp(xml).unwrap(), None);
    let output = workflow().embed_in_xmp(xml).unwrap();
    assert_eq!(
        SidecarWorkflow::from_xmp(&output).unwrap(),
        Some(workflow())
    );
    assert_eq!(
        crate::xmp::parse(&output).unwrap(),
        crate::xmp::parse(xml).unwrap()
    );
    assert!(output.contains("crs:Exposure2012=\"0.25\" "));
}

#[test]
fn unsupported_future_duplicate_or_unknown_workflow_is_never_replaced() {
    let record = workflow();
    let xml = record.embed_in_xmp(XMP).unwrap();
    let region = xml
        .split("<papp:Workflow")
        .nth(1)
        .unwrap()
        .split("</papp:Workflow>")
        .next()
        .unwrap();
    let duplicate = xml.replace(
        "</papp:Workflow>",
        &format!("</papp:Workflow><papp:Workflow{region}</papp:Workflow>"),
    );
    for invalid in [
        xml.replace("<papp:SchemaVersion>1", "<papp:SchemaVersion>2"),
        xml.replace("<papp:VariantName>", "<papp:FutureName>")
            .replace("</papp:VariantName>", "</papp:FutureName>"),
        xml.replace("rdf:parseType=\"Resource\"", "papp:Future=\"value\""),
        xml.replace(
            "<papp:SchemaVersion>1</papp:SchemaVersion>",
            "<papp:SchemaVersion>1</papp:SchemaVersion><papp:SchemaVersion>1</papp:SchemaVersion>",
        ),
        xml.replace(
            "<papp:VariantName>",
            "<papp:VariantName xmlns:papp=\"urn:foreign\">",
        ),
        xml.replace("<rdf:Seq>", "<rdf:Seq xmlns:rdf=\"urn:foreign\">"),
        xml.replace(
            "<papp:VariantName>",
            "<!-- future content --><papp:VariantName>",
        ),
        xml.replace("http://ns.justmaple.app/photo/1.0/", "urn:future"),
        duplicate,
    ] {
        let before = invalid.clone();
        assert!(SidecarWorkflow::from_xmp(&invalid).is_err());
        assert!(record.embed_in_xmp(&invalid).is_err());
        assert_eq!(invalid, before);
    }
}

#[test]
fn complete_checkpoint_crlf_entities_and_foreign_xml_bytes_are_lossless() {
    let record = workflow();
    let checkpoint = record.snapshots[0].adjustment_xmp.replace('\n', "\r\n");
    let record = SidecarWorkflow {
        snapshots: vec![WorkflowSnapshot {
            adjustment_xmp: checkpoint.clone(),
            ..record.snapshots[0].clone()
        }],
        ..record
    };
    let output = record.embed_in_xmp(XMP).unwrap();
    let reopened = SidecarWorkflow::from_xmp(&output).unwrap().unwrap();
    assert_eq!(reopened, record);
    assert_eq!(
        reopened.snapshots[0].adjustment_xmp.as_bytes(),
        checkpoint.as_bytes()
    );
}

#[test]
fn malformed_envelope_or_recursive_checkpoint_cannot_be_published() {
    let record = workflow();
    for invalid in [
        "not xml",
        "<rdf:RDF><rdf:Description>\0</rdf:Description></rdf:RDF>",
        "<rdf:Description />",
        "<rdf:RDF><rdf:Description>",
        "<other><rdf:Description/></other>",
    ] {
        assert!(record.embed_in_xmp(invalid).is_err());
    }
    let existing = record.embed_in_xmp(XMP).unwrap();
    let recursive = SidecarWorkflow {
        snapshots: vec![WorkflowSnapshot {
            adjustment_xmp: existing,
            ..record.snapshots[0].clone()
        }],
        ..record
    };
    assert!(recursive.embed_in_xmp(XMP).is_err());
}
