use super::*;

/// The shared UI pump, with room for the background estimate in a debug build.
fn pump(app: &mut MapleApp, condition: impl Fn(&MapleApp) -> bool) {
    let context = egui::Context::default();
    let deadline = Instant::now() + Duration::from_secs(120);
    while !condition(app) {
        assert!(Instant::now() < deadline, "UI timed out: {:?}", app.error);
        let input = egui::RawInput {
            screen_rect: Some(egui::Rect::from_min_size(
                egui::Pos2::ZERO,
                egui::vec2(1280.0, 800.0),
            )),
            ..Default::default()
        };
        let _ = context.run(input, |context| {
            app.poll(context);
            app.views(context);
        });
        std::thread::sleep(Duration::from_millis(5));
    }
}

#[test]
fn before_after_shows_name_only_auto_and_follows_the_pair_when_it_lands() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("photo.dng");
    std::fs::copy(
        PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../../test-fixtures/batch-transfer/source.dng"),
        &path,
    )
    .unwrap();
    let xml = r#"<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><rdf:Description xmlns:crs="http://ns.adobe.com/camera-raw-settings/1.0/" crs:WhiteBalance="Auto"/></rdf:RDF></x:xmpmeta>"#;
    std::fs::write(path.with_extension("xmp"), xml).unwrap();
    let mut app = MapleApp::from_context(egui::Context::default());
    app.open_folder(directory.path().into());
    pump(&mut app, |app| app.folder.is_some());
    app.select(app.folder.as_ref().unwrap().photos[0].clone());
    // Before/After from the moment the photo opens: the Before request is queued
    // ahead of the first frame, so it always precedes the estimate.
    app.comparing = true;
    pump(&mut app, |app| app.comparison_model.is_some());
    assert!(app.imported_auto.is_none());
    // The stored model is the one the worker renders As Shot and echoes back.
    assert!(!app.comparison_model.as_ref().unwrap().unresolved_auto_wb);
    pump(&mut app, |app| {
        app.texture.is_some() && app.comparison_texture.is_some()
    });
    // Once the pair lands, Before re-renders with it, like the edited view.
    pump(&mut app, |app| {
        app.imported_auto.is_some()
            && app.comparison_texture.is_some()
            && app
                .comparison_model
                .as_ref()
                .is_some_and(|model| (model.temperature, model.tint) == app.imported_auto.unwrap())
    });
    assert!(!app.comparison_model.as_ref().unwrap().unresolved_auto_wb);
    assert!(raw_core::stages::imported_auto_wb::needs_resolution(
        &app.document.as_ref().unwrap().model
    ));
    assert_eq!(
        std::fs::read_to_string(path.with_extension("xmp")).unwrap(),
        xml
    );
}
