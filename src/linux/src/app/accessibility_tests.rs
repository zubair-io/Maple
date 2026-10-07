use super::film_tests::{click, frame};
use super::*;

#[test]
fn accessible_thumbnail_opens_named_photo_without_modifying_original_or_sidecar() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("grey.dng");
    let bytes = std::fs::read(
        PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../apple/MapleUITests/Fixtures/synthetic/grey-l018-rggb.dng"),
    )
    .unwrap();
    std::fs::write(&path, &bytes).unwrap();
    let context = egui::Context::default();
    context.enable_accesskit();
    let mut app = MapleApp::from_context(context.clone());
    app.open_folder(directory.path().into());
    let deadline = Instant::now() + Duration::from_secs(10);
    loop {
        frame(&mut app, &context, Vec::new());
        if app.thumbnail_cache.get(&path).is_some_and(Result::is_ok) {
            break;
        }
        assert!(Instant::now() < deadline, "thumbnail did not load");
        std::thread::sleep(Duration::from_millis(5));
    }
    assert!(app.browse);
    let nodes = frame(&mut app, &context, Vec::new());
    assert!(nodes.iter().any(|(_, node)| {
        node.role() == egui::accesskit::Role::Window && node.label() == Some("Maple")
    }));
    click(&mut app, &context, "Open grey.dng");
    loop {
        frame(&mut app, &context, Vec::new());
        if app.document.is_some() && app.texture.is_some() {
            break;
        }
        assert!(Instant::now() < deadline, "accessible photo open timed out");
        std::thread::sleep(Duration::from_millis(5));
    }
    assert!(!app.browse);
    assert_eq!(app.selected.as_ref().unwrap().path, path);
    assert!(app.history.is_empty());
    assert!(app.dirty.is_none());
    assert_eq!(std::fs::read(&path).unwrap(), bytes);
    assert!(!path.with_extension("xmp").exists());
}
