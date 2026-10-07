use super::film_tests::{click, frame};
use super::*;
use crate::controls::Control;

fn key(app: &mut MapleApp, context: &egui::Context, modifiers: egui::Modifiers) {
    frame(
        app,
        context,
        vec![egui::Event::Key {
            key: egui::Key::Z,
            physical_key: Some(egui::Key::Z),
            pressed: true,
            repeat: false,
            modifiers,
        }],
    );
}

#[test]
fn command_history_shortcuts_preserve_zoom_and_leave_text_undo_to_the_editor() {
    let (directory, path) = super::tests::fixture();
    let original = std::fs::read(&path).unwrap();
    let context = egui::Context::default();
    context.enable_accesskit();
    let mut app = MapleApp::from_context(context.clone());
    app.open_folder(directory.path().into());
    let deadline = Instant::now() + Duration::from_secs(10);
    loop {
        frame(&mut app, &context, Vec::new());
        if app.folder.is_some() {
            break;
        }
        assert!(Instant::now() < deadline);
        std::thread::sleep(Duration::from_millis(5));
    }
    click(&mut app, &context, "Open grey.dng");
    loop {
        frame(&mut app, &context, Vec::new());
        if app.document.is_some() && app.texture.is_some() && app.zoom.native.is_some() {
            break;
        }
        assert!(Instant::now() < deadline);
        std::thread::sleep(Duration::from_millis(5));
    }
    app.history.push(app.document.as_ref().unwrap().clone());
    Control::Exposure
        .set(&mut app.document.as_mut().unwrap().model, 0.75)
        .unwrap();
    app.changed();
    key(
        &mut app,
        &context,
        egui::Modifiers::CTRL | egui::Modifiers::COMMAND,
    );
    assert_eq!(app.document.as_ref().unwrap().model.exposure, 0.0);
    assert_eq!(app.zoom.scale, 0.0, "Undo must not trigger 100% zoom");
    assert_eq!(app.redo.len(), 1);
    key(
        &mut app,
        &context,
        egui::Modifiers::CTRL | egui::Modifiers::COMMAND | egui::Modifiers::SHIFT,
    );
    assert_eq!(app.document.as_ref().unwrap().model.exposure, 0.75);
    assert_eq!(app.zoom.scale, 0.0);
    key(&mut app, &context, egui::Modifiers::ALT);
    assert_eq!(app.zoom.scale, 0.0, "Modified Z must not change zoom");
    app.cloud.active = true;
    key(
        &mut app,
        &context,
        egui::Modifiers::CTRL | egui::Modifiers::COMMAND,
    );
    assert_eq!(app.document.as_ref().unwrap().model.exposure, 0.75);
    app.cloud.active = false;
    app.cloud.downloading = true;
    key(
        &mut app,
        &context,
        egui::Modifiers::CTRL | egui::Modifiers::COMMAND,
    );
    assert_eq!(app.document.as_ref().unwrap().model.exposure, 0.75);
    app.cloud.downloading = false;
    let text = egui::Id::new("focused-numeric-editor");
    egui::text_edit::TextEditState::default().store(&context, text);
    context.memory_mut(|memory| memory.request_focus(text));
    key(
        &mut app,
        &context,
        egui::Modifiers::CTRL | egui::Modifiers::COMMAND,
    );
    assert_eq!(app.document.as_ref().unwrap().model.exposure, 0.75);
    assert_eq!(app.history.len(), 1);
    context.memory_mut(|memory| memory.surrender_focus(text));
    key(&mut app, &context, egui::Modifiers::NONE);
    assert_eq!(app.zoom.scale, 1.0, "Plain Z keeps native zoom");
    app.flush();
    while app.saving != 0 {
        frame(&mut app, &context, Vec::new());
        assert!(Instant::now() < deadline);
        std::thread::sleep(Duration::from_millis(5));
    }
    let (_, saved) = crate::sidecar::SidecarStore::open(&path).unwrap();
    assert_eq!(saved.model.exposure, 0.75);
    assert_eq!(std::fs::read(path).unwrap(), original);
    drop(directory);
}
