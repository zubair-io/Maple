use super::*;
use crate::ingest::{PlanarImage, ValidityMask};
use crate::seam::{constraints::rasterize, labels::compute_labels};

fn request() -> SeamConstraintsRequest {
    SeamConstraintsRequest::parse(r#"{"version":1,"canvas":{"width":100,"height":80},"regions":[{"kind":"include","frame":1,"x":11,"y":9,"width":21,"height":17},{"kind":"exclude","frame":0,"x":50,"y":40,"width":10,"height":8}]}"#, 2).unwrap()
}

#[test]
fn schema_round_trip_preserves_order_and_exact_intent() {
    let value = request();
    let json = serde_json::to_string(&value).unwrap();
    assert_eq!(SeamConstraintsRequest::parse(&json, 2).unwrap(), value);
    assert_eq!(serde_json::to_string(&request()).unwrap(), json);
    assert_eq!(
        value.for_canvas(100, 80).collect::<Vec<_>>(),
        value.constraints()
    );
    assert_eq!(
        value.for_canvas(50, 40).next().unwrap().rect(),
        CanvasRect {
            x: 5,
            y: 4,
            width: 11,
            height: 9,
        }
    );
    assert_eq!(
        value.for_canvas(200, 160).nth(1).unwrap().rect(),
        CanvasRect {
            x: 100,
            y: 80,
            width: 20,
            height: 16,
        }
    );
}

#[test]
fn invalid_schema_and_rois_are_named_refusals() {
    let valid = serde_json::to_value(request()).unwrap();
    for (field, value) in [
        ("version", serde_json::json!(2)),
        ("version", serde_json::json!(1.5)),
        ("extra", serde_json::json!(true)),
        ("canvas", serde_json::json!({"width":0,"height":80})),
    ] {
        let mut changed = valid.clone();
        changed[field] = value;
        let error = SeamConstraintsRequest::parse(&changed.to_string(), 2).unwrap_err();
        assert!(error.to_string().contains("invalid_seam_constraints"));
    }
    for (field, value) in [
        ("kind", serde_json::json!("keep")),
        ("width", serde_json::json!(0)),
        ("x", serde_json::json!(-1)),
        ("x", serde_json::json!(0.5)),
        ("width", serde_json::json!(u32::MAX)),
        ("y", serde_json::json!(80)),
        ("extra", serde_json::json!(true)),
    ] {
        let mut changed = valid.clone();
        changed["regions"][0][field] = value;
        assert!(
            SeamConstraintsRequest::parse(&changed.to_string(), 2).is_err(),
            "{field}"
        );
    }
    assert!(matches!(
        SeamConstraintsRequest::parse(&valid.to_string(), 1),
        Err(SeamConstraintError::UnknownFrame { .. })
    ));
}

#[test]
fn pano_01_wave_rois_drive_real_graph_cut_pins_deterministically() {
    #[derive(Deserialize)]
    struct Roi {
        rect: [u32; 4],
    }
    let rois: Vec<Roi> = serde_json::from_str(include_str!(
        "../../../../../test-fixtures/pano-motion-rois/pano_01.json"
    ))
    .unwrap();
    assert_eq!(rois.len(), 2);
    let regions = rois
        .iter()
        .enumerate()
        .map(|(i, r)| SeamRegion {
            kind: if i == 0 {
                SeamRegionKind::Include
            } else {
                SeamRegionKind::Exclude
            },
            frame: if i == 0 { 1 } else { 0 },
            x: r.rect[0],
            y: r.rect[1],
            width: r.rect[2],
            height: r.rect[3],
        })
        .collect();
    let request = SeamConstraintsRequest {
        version: 1,
        canvas: SeamConstraintCanvas {
            width: 20_000,
            height: 10_000,
        },
        regions,
    };
    request.validate(2).unwrap();
    let constraints = request.constraints();
    let layers: Vec<_> = (0..2)
        .map(|_| {
            PlanarImage::from_planes(
                200,
                100,
                vec![0.2; 20_000],
                vec![0.3; 20_000],
                vec![0.4; 20_000],
                ValidityMask::new_filled(200, 100, true),
            )
        })
        .collect();
    let pins = rasterize(&constraints, &layers, 0.01, 0.01).unwrap();
    let labels = compute_labels(&layers, &pins).unwrap();
    assert_eq!(labels, compute_labels(&layers, &pins).unwrap());
    for roi in request.for_canvas(200, 100) {
        let r = roi.rect();
        for y in r.y..r.y + r.height {
            for x in r.x..r.x + r.width {
                assert_eq!(labels[(y * 200 + x) as usize], 1);
            }
        }
    }
}
