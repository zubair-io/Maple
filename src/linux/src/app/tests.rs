use super::*;
use crate::controls::Control;

pub(super) fn fixture() -> (tempfile::TempDir, PathBuf) {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("grey.dng");
    std::fs::copy(
        PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../apple/MapleUITests/Fixtures/synthetic/grey-l018-rggb.dng"),
        &path,
    )
    .unwrap();
    (directory, path)
}

fn pump(app: &mut MapleApp, condition: impl Fn(&MapleApp) -> bool) {
    let context = egui::Context::default();
    let deadline = Instant::now() + Duration::from_secs(10);
    while !condition(app) {
        assert!(Instant::now() < deadline, "UI timed out: {:?}", app.error);
        let input = egui::RawInput {
            screen_rect: Some(egui::Rect::from_min_size(
                egui::Pos2::ZERO,
                egui::vec2(1280.0, 800.0),
            )),
            ..Default::default()
        };
        let output = context.run(input, |context| {
            app.poll(context);
            app.views(context);
        });
        assert!(!output.shapes.is_empty());
        std::thread::sleep(Duration::from_millis(5));
    }
}

#[test]
fn browse_preview_and_deferred_navigation_save_before_switching() {
    let (directory, path) = fixture();
    let mut app = MapleApp::from_context(egui::Context::default());
    app.open_folder(directory.path().into());
    pump(&mut app, |app| app.folder.is_some());
    app.select(app.folder.as_ref().unwrap().photos[0].clone());
    pump(&mut app, |app| app.texture.is_some());
    assert!(app.white_balance.is_some());
    assert!(!app.document.as_ref().unwrap().model.temperature_seen);
    assert!(!app.document.as_ref().unwrap().model.tint_seen);
    Control::Exposure
        .set(&mut app.document.as_mut().unwrap().model, 1.0)
        .unwrap();
    app.changed();
    app.open_folder(directory.path().into());
    assert!(app.pending_navigation.is_some());
    pump(&mut app, |app| {
        app.pending_navigation.is_none() && app.browse
    });
    let (_, saved) = crate::sidecar::SidecarStore::open(&path).unwrap();
    assert_eq!(saved.model.exposure, 1.0);
    assert!(!saved.model.temperature_seen && !saved.model.tint_seen);
}

#[test]
fn failed_save_stops_navigation_and_retains_edited_document() {
    let (directory, path) = fixture();
    let mut app = MapleApp::from_context(egui::Context::default());
    app.open_folder(directory.path().into());
    pump(&mut app, |app| app.folder.is_some());
    app.select(app.folder.as_ref().unwrap().photos[0].clone());
    pump(&mut app, |app| app.texture.is_some());
    Control::Exposure
        .set(&mut app.document.as_mut().unwrap().model, 2.0)
        .unwrap();
    app.changed();
    std::fs::write(path.with_extension("xmp"), "external contents").unwrap();
    app.open_folder(directory.path().into());
    pump(&mut app, |app| app.save_failed);
    assert!(app.pending_navigation.is_none());
    assert!(!app.browse);
    assert_eq!(app.document.as_ref().unwrap().model.exposure, 2.0);
    assert_eq!(
        std::fs::read_to_string(path.with_extension("xmp")).unwrap(),
        "external contents"
    );
}

#[test]
fn reset_is_one_undoable_action_and_saves_through_the_existing_worker() {
    let (directory, path) = fixture();
    let original = std::fs::read(&path).unwrap();
    let mut app = MapleApp::from_context(egui::Context::default());
    app.open_folder(directory.path().into());
    pump(&mut app, |app| app.folder.is_some());
    app.select(app.folder.as_ref().unwrap().photos[0].clone());
    pump(&mut app, |app| app.texture.is_some());
    let document = app.document.as_mut().unwrap();
    Control::Exposure.set(&mut document.model, 2.0).unwrap();
    document.model.profile = raw_core::types::adjustment::Profile::Neutral;
    document.culling.rating = 3;
    app.reset_develop();
    assert_eq!(app.history.len(), 1);
    assert_eq!(app.document.as_ref().unwrap().model.exposure, 0.0);
    assert_eq!(app.document.as_ref().unwrap().culling.rating, 3);
    app.undo(false);
    assert_eq!(app.document.as_ref().unwrap().model.exposure, 2.0);
    app.undo(true);
    assert_eq!(app.document.as_ref().unwrap().model.exposure, 0.0);
    app.flush();
    pump(&mut app, |app| app.saving == 0);
    let (_, reopened) = crate::sidecar::SidecarStore::open(&path).unwrap();
    assert_eq!(reopened.model.exposure, 0.0);
    assert_eq!(
        reopened.model.profile,
        raw_core::types::adjustment::Profile::Auto
    );
    assert_eq!(reopened.culling.rating, 3);
    assert_eq!(std::fs::read(path).unwrap(), original);
}

#[test]
fn auto_uses_shared_estimator_one_history_entry_and_real_xmp_persistence() {
    let (directory, path) = fixture();
    let original = std::fs::read(&path).unwrap();
    let mut app = MapleApp::from_context(egui::Context::default());
    app.open_folder(directory.path().into());
    pump(&mut app, |app| app.folder.is_some());
    app.select(app.folder.as_ref().unwrap().photos[0].clone());
    pump(&mut app, |app| app.texture.is_some());
    app.auto_adjust();
    assert!(app.auto_pending.is_some());
    pump(&mut app, |app| app.auto_pending.is_none());
    assert!(app.error.is_none(), "{:?}", app.error);
    assert_eq!(app.history.len(), 1);
    let model = &app.document.as_ref().unwrap().model;
    assert_eq!(model.wb_source, raw_core::types::adjustment::WbSource::Auto);
    assert_eq!(
        model.auto_exposure,
        raw_core::types::adjustment::AutoExposureMode::Off
    );
    assert_eq!(
        model.wb_algorithm_version,
        raw_core::stages::auto_adjustments::AUTO_WB_ALGORITHM_VERSION as f32
    );
    assert!(model.temperature_seen && model.tint_seen);
    app.flush();
    pump(&mut app, |app| app.saving == 0);
    let (_, reopened) = crate::sidecar::SidecarStore::open(&path).unwrap();
    assert_eq!(
        reopened.model.wb_source,
        raw_core::types::adjustment::WbSource::Auto
    );
    assert_eq!(
        reopened.model.auto_exposure,
        raw_core::types::adjustment::AutoExposureMode::Off
    );
    assert_eq!(
        reopened.model.wb_algorithm_version,
        raw_core::stages::auto_adjustments::AUTO_WB_ALGORITHM_VERSION as f32
    );
    app.undo(false);
    assert_eq!(
        app.document.as_ref().unwrap().model.wb_source,
        raw_core::types::adjustment::WbSource::AsShot
    );
    app.undo(true);
    assert_eq!(
        app.document.as_ref().unwrap().model.wb_source,
        raw_core::types::adjustment::WbSource::Auto
    );
    assert_eq!(std::fs::read(path).unwrap(), original);
}

#[test]
fn an_edit_during_auto_analysis_cannot_be_replaced_by_its_late_result() {
    let (directory, _) = fixture();
    let mut app = MapleApp::from_context(egui::Context::default());
    app.open_folder(directory.path().into());
    pump(&mut app, |app| app.folder.is_some());
    app.select(app.folder.as_ref().unwrap().photos[0].clone());
    pump(&mut app, |app| app.texture.is_some());
    app.auto_adjust();
    Control::Exposure
        .set(&mut app.document.as_mut().unwrap().model, 2.0)
        .unwrap();
    app.changed();
    pump(&mut app, |app| app.auto_pending.is_none());
    assert_eq!(app.document.as_ref().unwrap().model.exposure, 2.0);
    assert!(app.history.is_empty());
    assert_eq!(
        app.document.as_ref().unwrap().model.wb_source,
        raw_core::types::adjustment::WbSource::AsShot
    );
}

#[test]
fn navigation_while_auto_runs_saves_the_user_snapshot_without_late_analysis() {
    let (directory, path) = fixture();
    let mut app = MapleApp::from_context(egui::Context::default());
    app.open_folder(directory.path().into());
    pump(&mut app, |app| app.folder.is_some());
    app.select(app.folder.as_ref().unwrap().photos[0].clone());
    pump(&mut app, |app| app.texture.is_some());
    Control::Exposure
        .set(&mut app.document.as_mut().unwrap().model, 1.0)
        .unwrap();
    app.changed();
    app.auto_adjust();
    app.open_folder(directory.path().into());
    pump(&mut app, |app| app.browse && app.saving == 0);
    let (_, saved) = crate::sidecar::SidecarStore::open(&path).unwrap();
    assert_eq!(saved.model.exposure, 1.0);
    assert_eq!(
        saved.model.wb_source,
        raw_core::types::adjustment::WbSource::AsShot
    );
    assert!(app.history.is_empty());
}

#[test]
fn comparison_uses_the_open_snapshot_without_editing_history_or_sidecar() {
    let (directory, path) = fixture();
    let mut imported = crate::sidecar::SidecarDocument::default();
    Control::Exposure.set(&mut imported.model, 1.0).unwrap();
    let xml = imported.serialize().unwrap();
    std::fs::write(path.with_extension("xmp"), &xml).unwrap();
    let mut app = MapleApp::from_context(egui::Context::default());
    app.open_folder(directory.path().into());
    pump(&mut app, |app| app.folder.is_some());
    app.select(app.folder.as_ref().unwrap().photos[0].clone());
    pump(&mut app, |app| app.texture.is_some());
    Control::Exposure
        .set(&mut app.document.as_mut().unwrap().model, 2.0)
        .unwrap();
    app.comparing = true;
    app.request_comparison();
    pump(&mut app, |app| app.comparison_texture.is_some());
    assert_eq!(app.comparison_model.as_ref().unwrap().exposure, 1.0);
    assert_eq!(app.document.as_ref().unwrap().model.exposure, 2.0);
    assert!(app.history.is_empty() && app.redo.is_empty() && app.dirty.is_none());
    assert_eq!(
        std::fs::read_to_string(path.with_extension("xmp")).unwrap(),
        xml
    );
    let texture = app.comparison_texture.as_ref().unwrap().id();
    app.comparison_split = 0.2;
    app.request_comparison();
    assert_eq!(app.comparison_texture.as_ref().unwrap().id(), texture);
    // Reopening binds a new immutable before snapshot and rejects the previous cache.
    app.select(app.folder.as_ref().unwrap().photos[0].clone());
    assert!(app.comparison_texture.is_none() && !app.comparing);
    pump(&mut app, |app| app.texture.is_some());
    assert_eq!(app.comparison_baseline.as_ref().unwrap().exposure, 1.0);
}
