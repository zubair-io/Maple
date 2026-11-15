use super::film_tests::{click, frame};
use super::*;

fn names(app: &MapleApp) -> Vec<String> {
    app.folder
        .as_ref()
        .unwrap()
        .photos
        .iter()
        .map(|photo| photo.path.file_name().unwrap().to_str().unwrap().to_owned())
        .collect()
}

fn wait_for_folder(app: &mut MapleApp, context: &egui::Context) {
    let deadline = Instant::now() + Duration::from_secs(10);
    while app.folder.is_none() || app.busy {
        assert!(
            Instant::now() < deadline,
            "folder timed out: {:?}",
            app.error
        );
        frame(app, context, Vec::new());
        std::thread::sleep(Duration::from_millis(5));
    }
}

#[test]
fn accessible_local_sort_reorders_grid_and_filmstrip_without_editing_the_photo() {
    let (directory, path) = super::tests::fixture();
    let original = std::fs::read(&path).unwrap();
    std::fs::remove_file(&path).unwrap();
    for (name, padding, modified) in [("a.dng", 1, 30), ("m.dng", 2, 10), ("z.dng", 0, 20)] {
        let path = directory.path().join(name);
        let mut bytes = original.clone();
        bytes.resize(bytes.len() + padding, 0);
        std::fs::write(&path, bytes).unwrap();
        std::fs::File::options()
            .write(true)
            .open(&path)
            .unwrap()
            .set_times(
                std::fs::FileTimes::new().set_modified(
                    std::time::SystemTime::UNIX_EPOCH + Duration::from_secs(modified),
                ),
            )
            .unwrap();
    }
    let context = egui::Context::default();
    context.enable_accesskit();
    let mut app = MapleApp::from_context(context.clone());
    app.open_folder(directory.path().into());
    wait_for_folder(&mut app, &context);
    assert_eq!(names(&app), ["a.dng", "m.dng", "z.dng"]);
    let selected = app.folder.as_ref().unwrap().photos[2].clone();
    app.selected = Some(selected.clone());
    let (_, mut document) = crate::sidecar::SidecarStore::open(&selected.path).unwrap();
    document.model.exposure = 0.75;
    app.document = Some(document);
    app.dirty = Some(Instant::now());
    let session = app.session;
    let epoch = app.thumbnail_epoch;

    click(&mut app, &context, "Sort by");
    click(&mut app, &context, "File size");
    assert_eq!(names(&app), ["z.dng", "a.dng", "m.dng"]);
    click(&mut app, &context, "Descending");
    assert_eq!(names(&app), ["m.dng", "a.dng", "z.dng"]);
    click(&mut app, &context, "Sort by");
    click(&mut app, &context, "Modified time");
    assert_eq!(names(&app), ["a.dng", "z.dng", "m.dng"]);
    click(&mut app, &context, "Descending");
    assert_eq!(names(&app), ["m.dng", "z.dng", "a.dng"]);
    assert_eq!(app.selected.as_ref().unwrap().path, selected.path);
    assert_eq!(app.document.as_ref().unwrap().model.exposure, 0.75);
    assert!(app.dirty.is_some());
    assert!(app.history.is_empty());
    assert_eq!(app.session, session);
    assert_eq!(app.thumbnail_epoch, epoch);
    app.browse = false;
    let nodes = frame(&mut app, &context, Vec::new());
    let mut filmstrip: Vec<_> = nodes
        .iter()
        .filter_map(|(_, node)| {
            let label = node.label()?;
            (label.starts_with("Open ") && label.ends_with(".dng"))
                .then(|| (node.bounds().unwrap().x0, label))
        })
        .collect();
    filmstrip.sort_by(|a, b| a.0.total_cmp(&b.0));
    assert_eq!(
        filmstrip
            .iter()
            .map(|(_, label)| *label)
            .collect::<Vec<_>>(),
        ["Open m.dng", "Open z.dng", "Open a.dng"]
    );
    assert_eq!(std::fs::read(&selected.path).unwrap(), original);
    assert!(!selected.path.with_extension("xmp").exists());

    app.dirty = None;
    app.open_folder(directory.path().into());
    wait_for_folder(&mut app, &context);
    assert_eq!(names(&app), ["m.dng", "z.dng", "a.dng"]);
}
