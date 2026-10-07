use super::*;
use egui::accesskit::{Action, ActionData, ActionRequest, Node, NodeId};

pub(super) fn frame(
    app: &mut MapleApp,
    context: &egui::Context,
    events: Vec<egui::Event>,
) -> Vec<(NodeId, Node)> {
    let input = egui::RawInput {
        screen_rect: Some(egui::Rect::from_min_size(
            egui::Pos2::ZERO,
            egui::vec2(1280.0, 800.0),
        )),
        events,
        ..Default::default()
    };
    context
        .run(input, |context| {
            app.poll(context);
            app.views(context);
        })
        .platform_output
        .accesskit_update
        .expect("accessible native inspector")
        .nodes
}

pub(super) fn click(app: &mut MapleApp, context: &egui::Context, label: &str) {
    let nodes = frame(app, context, Vec::new());
    let target = nodes
        .iter()
        .find(|(_, node)| node.label() == Some(label))
        .unwrap_or_else(|| panic!("missing accessible control {label}"))
        .0;
    frame(
        app,
        context,
        vec![egui::Event::AccessKitActionRequest(ActionRequest {
            action: Action::Click,
            target,
            data: None,
        })],
    );
    for _ in 0..12 {
        frame(app, context, Vec::new());
    }
}

#[test]
fn accessible_film_picker_is_undoable_and_saves_a_real_sidecar() {
    let directory = tempfile::tempdir().unwrap();
    let source = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../test-fixtures/batch-transfer/source.dng");
    let path = directory.path().join("photo.dng");
    let bytes = std::fs::read(source).unwrap();
    std::fs::write(&path, &bytes).unwrap();
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
        if app.texture.is_some() {
            break;
        }
        std::thread::sleep(Duration::from_millis(5));
    }
    click(&mut app, &context, "Film");
    click(&mut app, &context, "Film look");
    click(
        &mut app,
        &context,
        raw_core::film_catalog::FILM_CATALOG[0].name,
    );
    assert_eq!(
        app.document.as_ref().unwrap().model.film_look,
        raw_core::film_catalog::FILM_CATALOG[0].id
    );
    assert_eq!(app.history.len(), 1);
    app.undo(false);
    assert!(app.document.as_ref().unwrap().model.film_look.is_empty());
    app.undo(true);
    assert_eq!(
        app.document.as_ref().unwrap().model.film_look,
        raw_core::film_catalog::FILM_CATALOG[0].id
    );
    let nodes = frame(&mut app, &context, Vec::new());
    let strength = nodes
        .iter()
        .find(|(_, node)| node.label() == Some("Strength"))
        .expect("accessible film strength")
        .0;
    frame(
        &mut app,
        &context,
        vec![egui::Event::AccessKitActionRequest(ActionRequest {
            action: Action::SetValue,
            target: strength,
            data: Some(ActionData::NumericValue(50.0)),
        })],
    );
    assert_eq!(app.document.as_ref().unwrap().model.film_strength, 50.0);
    assert_eq!(app.history.len(), 2);
    app.undo(false);
    assert_eq!(app.document.as_ref().unwrap().model.film_strength, 100.0);
    app.undo(true);
    assert_eq!(app.document.as_ref().unwrap().model.film_strength, 50.0);
    app.flush();
    for _ in 0..200 {
        frame(&mut app, &context, Vec::new());
        if app.saving == 0 {
            break;
        }
        std::thread::sleep(Duration::from_millis(5));
    }
    let (_, saved) = crate::sidecar::SidecarStore::open(&path).unwrap();
    assert_eq!(
        saved.model.film_look,
        raw_core::film_catalog::FILM_CATALOG[0].id
    );
    assert_eq!(saved.model.film_strength, 50.0);
    assert_eq!(std::fs::read(path).unwrap(), bytes);
}
