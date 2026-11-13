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
    assert_eq!(
        app.auto_fit,
        Some(raw_core::view::auto_profile::AutoFitOutcome::NoPreview)
    );
    let status = "Auto unavailable: no camera preview — showing Neutral.";
    assert_eq!(super::inspector::AUTO_NO_PREVIEW_STATUS, status);
    let exposes_status = |nodes: &[(egui::accesskit::NodeId, egui::accesskit::Node)]| {
        nodes
            .iter()
            .any(|(_, node)| node.label() == Some(status) || node.value() == Some(status))
    };
    assert!(
        exposes_status(&frame(&mut app, &context, Vec::new())),
        "the no-preview Auto status must be exposed to assistive technology"
    );
    app.document.as_mut().unwrap().model.profile = raw_core::types::adjustment::Profile::Neutral;
    assert!(
        !exposes_status(&frame(&mut app, &context, Vec::new())),
        "Neutral never shows the Auto fallback status"
    );
    assert_eq!(app.selected.as_ref().unwrap().path, path);
    assert!(app.history.is_empty());
    assert!(app.dirty.is_none());
    assert_eq!(std::fs::read(&path).unwrap(), bytes);
    assert!(!path.with_extension("xmp").exists());
}

/// #5207: an assistive-technology click aimed at the "Open grey.dng" node while
/// its thumbnail is still loading must still open the photo when the thumbnail
/// lands before the click is processed. The loading placeholder and the loaded
/// image are one accessible node, so the node a screen reader (or the Wayland
/// AT-SPI smoke) resolved keeps naming the same control across the swap.
#[test]
fn thumbnail_open_node_survives_the_thumbnail_load() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("grey.dng");
    std::fs::write(
        &path,
        std::fs::read(
            PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                .join("../apple/MapleUITests/Fixtures/synthetic/grey-l018-rggb.dng"),
        )
        .unwrap(),
    )
    .unwrap();
    let context = egui::Context::default();
    context.enable_accesskit();
    let mut app = MapleApp::from_context(context.clone());
    app.open_folder(directory.path().into());
    let open_node = |nodes: &[(egui::accesskit::NodeId, egui::accesskit::Node)]| {
        nodes
            .iter()
            .find(|(_, node)| node.label() == Some("Open grey.dng"))
            .map(|(id, _)| *id)
    };
    let deadline = Instant::now() + Duration::from_secs(10);
    // The listing arrives through `poll`, and the frame that first draws the
    // photo is the one that requests its thumbnail, so this node is always the
    // loading placeholder.
    let loading = loop {
        if let Some(node) = open_node(&frame(&mut app, &context, Vec::new())) {
            break node;
        }
        assert!(Instant::now() < deadline, "folder listing did not load");
        std::thread::sleep(Duration::from_millis(5));
    };
    assert!(!app.thumbnail_cache.contains_key(&path));
    while !app.thumbnail_cache.get(&path).is_some_and(Result::is_ok) {
        frame(&mut app, &context, Vec::new());
        assert!(Instant::now() < deadline, "thumbnail did not load");
        std::thread::sleep(Duration::from_millis(5));
    }
    assert_eq!(
        open_node(&frame(&mut app, &context, Vec::new())),
        Some(loading),
        "the loaded thumbnail must keep the placeholder's accessible node"
    );
    frame(
        &mut app,
        &context,
        vec![egui::Event::AccessKitActionRequest(
            egui::accesskit::ActionRequest {
                action: egui::accesskit::Action::Click,
                target: loading,
                data: None,
            },
        )],
    );
    while app.document.is_none() {
        frame(&mut app, &context, Vec::new());
        assert!(
            Instant::now() < deadline,
            "the click resolved against the loading placeholder was dropped"
        );
        std::thread::sleep(Duration::from_millis(5));
    }
    assert!(!app.browse);
    assert_eq!(app.selected.as_ref().unwrap().path, path);
}
