use super::film_tests::{click, frame};
use super::*;

#[test]
fn native_rejection_paints_whole_fallback_without_repeating_on_pan_or_editing_xmp() {
    let directory = tempfile::tempdir().unwrap();
    let bytes = std::fs::read(
        std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../test-fixtures/batch-transfer/source.dng"),
    )
    .unwrap();
    let path = directory.path().join("fallback.dng");
    std::fs::write(&path, &bytes).unwrap();
    let model = raw_core::AdjustmentModel {
        auto_lateral_ca: raw_core::types::adjustment::AutoLateralCa::On,
        ..Default::default()
    };
    let attributes = raw_core::xmp::serialize(&model);
    let xml = format!(
        r#"<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><rdf:Description xmlns:crs="http://ns.adobe.com/camera-raw-settings/1.0/" xmlns:papp="http://ns.justmaple.app/photo/1.0/"{attributes}/></rdf:RDF></x:xmpmeta>"#
    );
    std::fs::write(path.with_extension("xmp"), &xml).unwrap();
    let context = egui::Context::default();
    context.enable_accesskit();
    let mut app = MapleApp::from_context(context.clone());
    app.open_folder(directory.path().into());
    for _ in 0..200 {
        frame(&mut app, &context, Vec::new());
        if app.folder.is_some() {
            break;
        }
        std::thread::sleep(Duration::from_millis(5));
    }
    app.select(app.folder.as_ref().unwrap().photos[0].clone());
    for _ in 0..200 {
        frame(&mut app, &context, Vec::new());
        if app.texture.is_some() && app.zoom.native.is_some() {
            break;
        }
        std::thread::sleep(Duration::from_millis(5));
    }
    assert_eq!(
        app.document.as_ref().unwrap().model.auto_lateral_ca,
        model.auto_lateral_ca
    );
    click(&mut app, &context, "100%");
    for _ in 0..400 {
        frame(&mut app, &context, Vec::new());
        if app.zoom.patch.is_some() {
            break;
        }
        std::thread::sleep(Duration::from_millis(5));
    }
    assert!(app.zoom.error.is_none(), "{:?}", app.zoom.error);
    assert_eq!(
        app.zoom.resolution_status.as_deref(),
        Some("Whole-image refinement")
    );
    assert!(!app.zoom.refining());
    let generation = app.zoom.generation;
    // Use a narrow canvas because the floating inspector no longer reserves
    // width. The fixture must exceed the viewport at the supported 8x limit.
    app.zoom.scale = 8.0;
    app.zoom.pan = egui::vec2(20.0, -20.0);
    for _ in 0..50 {
        let input = egui::RawInput {
            screen_rect: Some(egui::Rect::from_min_size(
                egui::Pos2::ZERO,
                egui::vec2(400.0, 600.0),
            )),
            ..Default::default()
        };
        let _ = context.run(input, |context| {
            app.poll(context);
            app.views(context);
        });
    }
    assert!(app.zoom.pan.x.abs() > 0.0, "exercise an actual clamped pan");
    assert_eq!(
        app.zoom.generation, generation,
        "panning reuses the whole fallback"
    );
    assert!(app.dirty.is_none() && app.history.is_empty());
    click(&mut app, &context, "Fit");
    assert!(app.zoom.patch.is_none());
    assert!(app.zoom.resolution_status.is_none());
    app.worker.finish();
    assert_eq!(std::fs::read(&path).unwrap(), bytes);
    assert_eq!(
        std::fs::read_to_string(path.with_extension("xmp")).unwrap(),
        xml
    );
}
