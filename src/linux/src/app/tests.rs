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
fn launching_with_a_photo_path_opens_its_folder_and_that_photo() {
    let (directory, path) = fixture();
    std::fs::write(directory.path().join("other.jpg"), b"not opened").unwrap();
    let mut app = MapleApp::from_context(egui::Context::default());
    app.open_path(path.clone());
    pump(&mut app, |app| app.texture.is_some());
    assert_eq!(app.folder.as_ref().unwrap().photos.len(), 2);
    assert_eq!(app.selected.as_ref().unwrap().path, path);
    assert!(!app.browse);
}

#[test]
fn launching_with_a_folder_or_an_unsupported_file_browses_that_folder() {
    let (directory, _) = fixture();
    let notes = directory.path().join("notes.txt");
    std::fs::write(&notes, b"not a photo").unwrap();
    for path in [directory.path().to_path_buf(), notes] {
        let mut app = MapleApp::from_context(egui::Context::default());
        app.open_path(path);
        pump(&mut app, |app| app.folder.is_some());
        assert_eq!(app.folder.as_ref().unwrap().photos.len(), 1);
        assert!(app.selected.is_none() && app.browse);
    }
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

#[test]
fn an_edit_made_while_a_save_is_in_flight_survives_the_deferred_navigation() {
    let (directory, path) = fixture();
    let mut app = MapleApp::from_context(egui::Context::default());
    app.open_folder(directory.path().into());
    pump(&mut app, |app| app.folder.is_some());
    let photo = app.folder.as_ref().unwrap().photos[0].clone();
    app.select(photo.clone());
    pump(&mut app, |app| app.texture.is_some());
    Control::Exposure
        .set(&mut app.document.as_mut().unwrap().model, 1.0)
        .unwrap();
    app.changed();
    app.select(photo);
    assert_eq!(app.saving, 1);
    Control::Exposure
        .set(&mut app.document.as_mut().unwrap().model, 2.0)
        .unwrap();
    app.changed();
    pump(&mut app, |app| {
        app.pending_navigation.is_none() && app.saving == 0
    });
    let (_, saved) = crate::sidecar::SidecarStore::open(&path).unwrap();
    assert_eq!(saved.model.exposure, 2.0);
}

#[test]
fn a_save_after_an_outside_edit_merges_and_the_editor_adopts_it() {
    let (directory, path) = fixture();
    let mut app = MapleApp::from_context(egui::Context::default());
    app.open_folder(directory.path().into());
    pump(&mut app, |app| app.folder.is_some());
    app.select(app.folder.as_ref().unwrap().photos[0].clone());
    pump(&mut app, |app| app.texture.is_some());
    let outside = r#"<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><rdf:Description rdf:about="" xmlns:crs="http://ns.adobe.com/camera-raw-settings/1.0/" crs:Vibrance="30"/></rdf:RDF></x:xmpmeta>"#;
    std::fs::write(path.with_extension("xmp"), outside).unwrap();
    Control::Exposure
        .set(&mut app.document.as_mut().unwrap().model, 1.0)
        .unwrap();
    app.changed();
    app.flush();
    pump(&mut app, |app| app.saving == 0);
    assert!(!app.save_failed, "{:?}", app.error);
    let adopted = &app.document.as_ref().unwrap().model;
    assert_eq!((adopted.exposure, adopted.vibrance), (1.0, 30.0));
    assert!(app.dirty.is_none(), "adoption schedules no save");
    let (_, saved) = crate::sidecar::SidecarStore::open(&path).unwrap();
    assert_eq!(saved.model, *adopted);
}

#[test]
fn a_merge_made_while_an_earlier_cloud_sync_is_in_flight_is_adopted_when_it_completes() {
    // #5888 review: cloud save A is still synchronizing when save B merges an
    // outside change. A's completion is stale for the editor and B's upload
    // reports no further merge, so B's merge must be kept, not discarded.
    let (directory, path) = fixture();
    let mut app = MapleApp::from_context(egui::Context::default());
    app.open_folder(directory.path().into());
    pump(&mut app, |app| app.folder.is_some());
    app.select(app.folder.as_ref().unwrap().photos[0].clone());
    pump(&mut app, |app| app.texture.is_some());
    let outside = r#"<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><rdf:Description rdf:about="" xmlns:crs="http://ns.adobe.com/camera-raw-settings/1.0/" crs:Vibrance="30"/></rdf:RDF></x:xmpmeta>"#;
    std::fs::write(path.with_extension("xmp"), outside).unwrap();
    let save_a = app.edit_revision;
    app.saving += 1; // Save A's cloud synchronization is in flight.
    Control::Exposure
        .set(&mut app.document.as_mut().unwrap().model, 1.0)
        .unwrap();
    app.changed();
    app.flush();
    pump(&mut app, |app| app.save_documents.is_empty());
    assert!(!app.save_failed, "{:?}", app.error);
    assert_eq!(app.saving, 1);
    assert_eq!(
        app.document.as_ref().unwrap().model.vibrance,
        0.0,
        "nothing is adopted while save A is still in flight"
    );

    app.cloud
        .synchronized
        .push_back((app.session, save_a, Ok(None)));
    pump(&mut app, |app| app.saving == 0);
    let adopted = &app.document.as_ref().unwrap().model;
    assert_eq!((adopted.exposure, adopted.vibrance), (1.0, 30.0));
    assert!(app.dirty.is_none(), "adoption schedules no save");
    let (_, saved) = crate::sidecar::SidecarStore::open(&path).unwrap();
    assert_eq!(saved.model, *adopted);
}

#[test]
fn a_redo_after_an_adopted_merge_and_a_saved_undo_keeps_the_redone_edit() {
    // #5887 review: Exposure 0 -> 1 while another app sets Vibrance, adopt the
    // merge, Undo and let it save, then Redo.
    let (directory, path) = fixture();
    let mut app = MapleApp::from_context(egui::Context::default());
    app.open_folder(directory.path().into());
    pump(&mut app, |app| app.folder.is_some());
    app.select(app.folder.as_ref().unwrap().photos[0].clone());
    pump(&mut app, |app| app.texture.is_some());
    let outside = r#"<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><rdf:Description rdf:about="" xmlns:crs="http://ns.adobe.com/camera-raw-settings/1.0/" crs:Vibrance="30"/></rdf:RDF></x:xmpmeta>"#;
    std::fs::write(path.with_extension("xmp"), outside).unwrap();
    app.history.push(app.document.as_ref().unwrap().clone());
    Control::Exposure
        .set(&mut app.document.as_mut().unwrap().model, 1.0)
        .unwrap();
    app.changed();
    app.flush();
    pump(&mut app, |app| app.saving == 0);
    let saved = |app: &MapleApp| {
        assert!(!app.save_failed, "{:?}", app.error);
        let model = crate::sidecar::SidecarStore::open(&path).unwrap().1.model;
        let shown = &app.document.as_ref().unwrap().model;
        assert_eq!(
            (shown.exposure, shown.vibrance),
            (model.exposure, model.vibrance)
        );
        (model.exposure, model.vibrance)
    };
    assert_eq!(saved(&app), (1.0, 30.0));

    app.undo(false);
    app.flush();
    pump(&mut app, |app| app.saving == 0);
    assert_eq!(saved(&app), (0.0, 30.0), "Undo keeps the outside change");

    app.undo(true);
    app.flush();
    pump(&mut app, |app| app.saving == 0);
    assert_eq!(saved(&app), (1.0, 30.0), "Redo lands");
}

#[test]
fn pending_cloud_handoff_exposes_recovery_without_a_new_save_failure() {
    let (_directory, path) = fixture();
    let (mut store, mut document) = crate::sidecar::SidecarStore::open(&path).unwrap();
    Control::Exposure.set(&mut document.model, 1.5).unwrap();
    store.save(&document).unwrap();
    let context = egui::Context::default();
    context.enable_accesskit();
    let mut app = MapleApp::from_context(context.clone());
    let photo = crate::library::Folder::scan(path.parent().unwrap())
        .unwrap()
        .photos[0]
        .clone();
    let entry = crate::cloud::CloudEntry {
        name: "grey.dng".into(),
        address: "library:grey.dng".into(),
        path: "/library/grey.dng".into(),
        ext: "dng".into(),
        id: None,
        size: photo.size,
        mtime: "2026-10-06T00:00:00Z".into(),
        is_video: false,
        is_audio: false,
        is_stub: false,
    };
    app.cloud.ready = Some((photo, entry, true));
    pump(&mut app, |app| app.document.is_some());
    assert!(
        app.save_failed,
        "a held journal must expose recovery immediately"
    );
    assert_eq!(app.document.as_ref().unwrap().model.exposure, 1.5);
    assert!(app.dirty.is_none());
    let nodes = super::film_tests::frame(&mut app, &context, Vec::new());
    assert!(nodes
        .iter()
        .any(|(_, node)| node.label() == Some("Reload XMP (discard edits)")));
    app.navigate(Navigation::CloudBrowse);
    assert!(
        app.cloud_editor.is_some(),
        "pending edits still guard navigation"
    );
}
