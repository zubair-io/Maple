use super::*;

fn document(body: &str) -> String {
    format!(
        r#"<x:xmpmeta xmlns:x="adobe:ns:meta/" xmlns:r="http://www.w3.org/1999/02/22-rdf-syntax-ns#" xmlns:p="http://ns.adobe.com/photoshop/1.0/" xmlns:c="{CAMERA_NS}"><r:RDF><r:Description><p:CameraProfiles><r:Seq>{body}</r:Seq></p:CameraProfiles></r:Description></r:RDF></x:xmpmeta>"#
    )
}

#[test]
fn attribute_and_element_properties_are_equivalent() {
    let attributes = parse(&document(r#"<r:li><r:Description c:Make="Example" c:Lens="24 &amp; 70" c:FocalLength="24"><c:PerspectiveModel c:Version="2" c:RadialDistortParam1="-0.1"/></r:Description></r:li>"#)).unwrap();
    let elements = parse(&document(r#"<r:li><r:Description><c:Make>Example</c:Make><c:Lens>24 &amp; 70</c:Lens><c:FocalLength>24</c:FocalLength><c:PerspectiveModel><c:Version>2</c:Version><c:RadialDistortParam1>-0.1</c:RadialDistortParam1></c:PerspectiveModel></r:Description></r:li>"#)).unwrap();
    assert_eq!(attributes, elements);
    assert_eq!(attributes.samples[0].properties["Lens"], "24 & 70");
}

#[test]
fn element_camera_identity_is_scalar_while_calibration_models_are_preserved() {
    let attributes = parse(&document(r#"<r:li c:Make="Example" c:Model="Body" c:UniqueCameraModel="Unique body" c:Lens="Prime" c:FocalLength="35" c:CameraRawProfile="True"><c:PerspectiveModel c:Version="2" c:RadialDistortParam1="0.1"/><c:FutureModel/></r:li>"#)).unwrap();
    let elements = parse(&document(r#"<r:li><c:Make>Example</c:Make><c:Model>Body</c:Model><c:UniqueCameraModel>Unique body</c:UniqueCameraModel><c:Lens>Prime</c:Lens><c:FocalLength>35</c:FocalLength><c:CameraRawProfile>True</c:CameraRawProfile><c:PerspectiveModel><c:Version>2</c:Version><c:RadialDistortParam1>0.1</c:RadialDistortParam1></c:PerspectiveModel><c:FutureModel/></r:li>"#)).unwrap();
    assert_eq!(attributes, elements);
    let sample = &elements.samples[0];
    assert_eq!(sample.properties["Model"], "Body");
    assert_eq!(sample.properties["UniqueCameraModel"], "Unique body");
    assert_eq!(sample.models.len(), 2);
    assert_eq!(sample.models[0].kind, "PerspectiveModel");
    assert_eq!(sample.models[1].kind, "FutureModel");
}

#[test]
fn alternate_lens_names_are_an_identity_property_not_an_optical_model() {
    let profile = parse(&document(r#"<r:li><r:Description c:Make="SONY" c:Lens="FE 24-70mm F4 ZA OSS" c:FocalLength="24" c:CameraRawProfile="True"><c:AlternateLensNames><r:Seq><r:li>24-70mm F4 ZA OSS</r:li><r:li>Sony FE 24-70mm F4 ZA OSS</r:li></r:Seq></c:AlternateLensNames><c:PerspectiveModel c:Version="2" c:RadialDistortParam1="-0.1"/></r:Description></r:li>"#)).unwrap();
    let sample = &profile.samples[0];
    assert_eq!(sample.models.len(), 1);
    assert_eq!(sample.models[0].kind, "PerspectiveModel");
    assert_eq!(
        sample.properties["AlternateLensNames"],
        format!(
            "24-70mm F4 ZA OSS{}Sony FE 24-70mm F4 ZA OSS",
            xml::LIST_SEPARATOR
        )
    );
}

#[test]
fn preserves_duplicate_samples_without_choosing_coefficients() {
    let sample = r#"<r:li c:Make="Example" c:Lens="Prime" c:FocalLength="50"><c:PerspectiveModel c:RadialDistortParam1="0.1"/></r:li>"#;
    let parsed = parse(&document(&format!("{sample}{sample}"))).unwrap();
    assert_eq!(parsed.samples.len(), 2);
    assert_eq!(parsed.samples[0], parsed.samples[1]);
    assert_eq!(parsed.inspection()["sampleCount"], 2);
}

#[test]
fn preserves_future_models_and_piecewise_rdf_values() {
    let parsed = parse(&document(r#"<r:li c:Make="Example"><c:FutureModel c:Version="4"><c:FutureParameter>0.4</c:FutureParameter><c:VignetteModelPiecewiseParam><r:Seq><r:li>1.0</r:li><r:li><![CDATA[0.8]]></r:li></r:Seq></c:VignetteModelPiecewiseParam></c:FutureModel></r:li>"#)).unwrap();
    let model = &parsed.samples[0].models[0];
    assert_eq!(model.kind, "FutureModel");
    assert_eq!(model.properties["FutureParameter"], "0.4");
    let values = &model.children[0].children[0].children;
    assert_eq!(values[0].text, "1.0");
    assert_eq!(values[1].text, "0.8");
}

#[test]
fn rejects_conflicting_attribute_and_element_property() {
    let xml = document(
        r#"<r:li c:FocalLength="50"><c:FocalLength>24</c:FocalLength><c:PerspectiveModel c:Version="2"/></r:li>"#,
    );
    assert!(parse(&xml).unwrap_err().contains("Conflicting"));
}

#[test]
fn requires_the_actual_profile_namespace() {
    let xml = document(r#"<r:li><c:PerspectiveModel c:Version="2"/></r:li>"#);
    assert!(parse(&xml.replace("http://ns.adobe.com/photoshop/1.0/", "urn:foreign")).is_err());
    assert!(parse(&xml.replace("c:Version", "undeclared:Version")).is_err());
}

#[test]
fn rejects_malformed_and_entity_defining_documents() {
    for xml in [
        "",
        "<a>",
        "<a/><b/>",
        "<!DOCTYPE a [<!ENTITY test 'abc'>]><a/>",
        "<a></b>",
    ] {
        assert!(parse(xml).is_err(), "accepted {xml}");
    }
}

#[test]
fn bounds_document_size_and_nesting() {
    assert!(parse(&" ".repeat(32 * 1024 * 1024 + 1))
        .unwrap_err()
        .contains("32 MiB"));
    let deep = format!("{}{}", "<a>".repeat(65), "</a>".repeat(65));
    assert!(parse(&deep).unwrap_err().contains("structure limit"));
}

#[test]
#[ignore = "requires MAPLE_LCP_TEST_DIR pointing to a locally installed profile corpus"]
fn installed_profile_corpus_parses_without_modifying_inputs() {
    fn visit(path: &std::path::Path, count: &mut usize, failures: &mut Vec<String>) {
        for entry in std::fs::read_dir(path).unwrap() {
            let entry = entry.unwrap();
            let path = entry.path();
            let kind = entry.file_type().unwrap();
            if kind.is_dir() {
                visit(&path, count, failures);
            } else if kind.is_file()
                && path
                    .extension()
                    .is_some_and(|e| e.eq_ignore_ascii_case("lcp"))
            {
                *count += 1;
                let xml = std::fs::read_to_string(&path).unwrap();
                if let Err(error) = parse(&xml) {
                    failures.push(format!("{}: {error}", path.display()));
                }
            }
        }
    }
    let directory = std::env::var("MAPLE_LCP_TEST_DIR").expect("set MAPLE_LCP_TEST_DIR");
    let mut count = 0;
    let mut failures = Vec::new();
    visit(std::path::Path::new(&directory), &mut count, &mut failures);
    eprintln!(
        "Inspected {count} installed profiles; {} parse errors",
        failures.len()
    );
    assert!(count > 0, "profile corpus is empty");
    assert!(failures.is_empty(), "{}", failures.join("\n"));
}

#[test]
fn odd_radial_terms_evaluate_the_ptlens_polynomial() {
    let p = model::Perspective {
        frame: model::Frame {
            focal: [1.0, 1.0],
            center: [0.5, 0.5],
        },
        radial: [0.02, 0.0, 0.0],
        radial_odd: [0.01, -0.03],
        tangential: [0.0; 2],
        scale: 1.0,
    };
    // width = height = 200 → focal 200 px; (150, 100) is x = 0.25, r = 0.25.
    let [x, y] = p.map(200.0, 200.0, [150.0, 100.0]);
    let r = 0.25f64;
    let poly = 1.0 + 0.01 * r + 0.02 * r * r - 0.03 * r * r * r;
    assert!((x - (100.0 + 50.0 * poly)).abs() < 1e-9, "{x}");
    assert!((y - 100.0).abs() < 1e-9);
}

#[test]
fn zero_odd_terms_are_the_adobe_polynomial() {
    let even = model::Perspective {
        frame: model::Frame {
            focal: [1.0, 1.0],
            center: [0.5, 0.5],
        },
        radial: [0.1, -0.05, 0.01],
        radial_odd: [0.0; 2],
        tangential: [0.001, -0.002],
        scale: 1.02,
    };
    let point = [173.0, 41.0];
    let [x, y] = even.map(300.0, 200.0, point);
    let [nx, ny] = even.frame.coordinates(300.0, 200.0, point);
    let r2 = nx * nx + ny * ny;
    let radial = 1.0 + r2 * (0.1 + r2 * (-0.05 + r2 * 0.01));
    let expected = even.frame.pixels(
        300.0,
        200.0,
        [
            1.02 * (nx * radial + 2.0 * 0.001 * nx * ny + -0.002 * (r2 + 2.0 * nx * nx)),
            1.02 * (ny * radial + 0.001 * (r2 + 2.0 * ny * ny) + 2.0 * -0.002 * nx * ny),
        ],
    );
    assert!((x - expected[0]).abs() < 1e-12 && (y - expected[1]).abs() < 1e-12);
}
