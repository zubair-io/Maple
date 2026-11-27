use super::film_tests::frame;
use super::filmstrip_tests::{
    editor_over, open_cells, photo, scroll_events, settle, texture_sizes, Nodes,
};
use super::*;

fn by_position(cells: &[(String, egui::accesskit::Rect)]) -> Vec<&(String, egui::accesskit::Rect)> {
    let mut ordered: Vec<_> = cells.iter().collect();
    ordered.sort_by(|a, b| a.1.x0.total_cmp(&b.1.x0));
    ordered
}

/// The last cell is laid out as an end of the strip, far from the cells in view.
const ANCHOR_GAP: f64 = 1_000.0;

fn assert_abutting(context: &egui::Context, cells: &[(String, egui::accesskit::Rect)]) {
    let spacing = f64::from(context.style().spacing.item_spacing.x);
    for pair in by_position(cells).windows(2) {
        let gap = pair[1].1.x0 - pair[0].1.x1;
        if gap > ANCHOR_GAP {
            continue;
        }
        assert!(
            (gap - spacing).abs() < 0.01,
            "{} then {} are {gap} apart, not {spacing}",
            pair[0].0,
            pair[1].0
        );
    }
}

fn two_photo_folder() -> (tempfile::TempDir, [PathBuf; 2]) {
    let (directory, path) = super::tests::fixture();
    let second = directory.path().join("grey-second.dng");
    std::fs::copy(&path, &second).unwrap();
    (directory, [path, second])
}

#[test]
fn a_thumbnail_arriving_moves_the_cells_after_it() {
    let (directory, paths) = two_photo_folder();
    let context = egui::Context::default();
    context.enable_accesskit();
    let mut app = MapleApp::from_context(context.clone());
    app.open_folder(directory.path().into());
    let deadline = Instant::now() + Duration::from_secs(20);
    let mut widths_seen = std::collections::HashSet::new();
    while !paths
        .iter()
        .all(|path| app.thumbnail_cache.get(path).is_some_and(Result::is_ok))
    {
        assert!(Instant::now() < deadline, "thumbnails did not load");
        let editing = !app.browse;
        let cells = open_cells(&frame(&mut app, &context, Vec::new()));
        if app.folder.is_some() && app.selected.is_none() {
            app.select(app.folder.as_ref().unwrap().photos[0].clone());
        }
        if editing {
            assert_abutting(&context, &cells);
            widths_seen.extend(cells.iter().map(|(_, rect)| (rect.x1 - rect.x0).to_bits()));
        }
        std::thread::sleep(Duration::from_millis(5));
    }
    let cells = open_cells(&frame(&mut app, &context, Vec::new()));
    assert_eq!(cells.len(), 2);
    assert_abutting(&context, &cells);
    assert!(widths_seen.len() > 1, "the cells never changed width");
}

fn leftmost_label(cells: &[(String, egui::accesskit::Rect)]) -> &str {
    &by_position(cells)[0].0
}

#[test]
fn sorting_the_photos_lays_the_filmstrip_out_in_the_new_order() {
    let context = egui::Context::default();
    context.enable_accesskit();
    let mut app = editor_over(&context, 30);
    let cells = open_cells(&frame(&mut app, &context, Vec::new()));
    assert!(leftmost_label(&cells).contains("IMG_00000"));
    assert_abutting(&context, &cells);

    app.sort_descending = true;
    app.apply_photo_sort();

    let cells = open_cells(&frame(&mut app, &context, Vec::new()));
    assert!(leftmost_label(&cells).contains("IMG_00029"), "{cells:?}");
    assert_abutting(&context, &cells);
}

#[test]
fn forgetting_the_thumbnails_returns_the_cells_to_their_names() {
    let context = egui::Context::default();
    context.enable_accesskit();
    let mut app = editor_over(&context, 30);
    app.thumbnail_cache
        .insert(photo(0).path, Ok(texture_sizes(&context, 0)));
    app.filmstrip.thumbnails_changed();
    assert_abutting(
        &context,
        &open_cells(&frame(&mut app, &context, Vec::new())),
    );

    app.invalidate_thumbnails();
    app.thumbnail_pending = app
        .folder
        .as_ref()
        .unwrap()
        .photos
        .iter()
        .map(|photo| photo.path.clone())
        .collect();

    assert_abutting(
        &context,
        &open_cells(&frame(&mut app, &context, Vec::new())),
    );
}

#[test]
fn a_new_listing_arriving_under_the_filmstrip_replaces_the_cells() {
    let (directory, _) = two_photo_folder();
    let context = egui::Context::default();
    context.enable_accesskit();
    let mut app = editor_over(&context, 2);
    frame(&mut app, &context, Vec::new());
    app.worker.send(Command::Folder(directory.path().into()));
    let deadline = Instant::now() + Duration::from_secs(10);
    while app
        .folder
        .as_ref()
        .is_none_or(|folder| folder.path != directory.path())
    {
        assert!(Instant::now() < deadline, "folder did not load");
        frame(&mut app, &context, Vec::new());
        std::thread::sleep(Duration::from_millis(5));
    }
    app.select(app.folder.as_ref().unwrap().photos[0].clone());

    let cells = open_cells(&frame(&mut app, &context, Vec::new()));

    let mut labels: Vec<&str> = cells.iter().map(|(label, _)| label.as_str()).collect();
    labels.sort_unstable();
    assert_eq!(labels, ["Open grey-second.dng", "Open grey.dng"]);
    assert_abutting(&context, &cells);
}

#[test]
fn an_arrival_or_eviction_measures_no_file_names_but_a_new_listing_or_style_measures_all() {
    let context = egui::Context::default();
    context.enable_accesskit();
    let mut app = editor_over(&context, 100);
    frame(&mut app, &context, Vec::new());
    assert_eq!(app.filmstrip.names_measured(), 101);

    app.thumbnail_cache
        .insert(photo(0).path, Ok(texture_sizes(&context, 0)));
    app.filmstrip.thumbnails_changed();
    frame(&mut app, &context, Vec::new());
    app.thumbnail_cache.remove(&photo(0).path);
    app.filmstrip.thumbnails_changed();
    frame(&mut app, &context, Vec::new());
    assert_eq!(app.filmstrip.names_measured(), 101, "thumbnail state only");

    app.filmstrip.photos_changed();
    frame(&mut app, &context, Vec::new());
    assert_eq!(app.filmstrip.names_measured(), 202, "a new listing");

    context.set_pixels_per_point(2.0);
    frame(&mut app, &context, Vec::new());
    assert_eq!(app.filmstrip.names_measured(), 303, "a style change");
}

#[test]
fn a_photo_list_that_changed_without_a_notice_is_measured_again() {
    let context = egui::Context::default();
    context.enable_accesskit();
    let mut app = editor_over(&context, 30);
    frame(&mut app, &context, Vec::new());

    app.folder.as_mut().unwrap().photos.truncate(5);

    let cells = open_cells(&frame(&mut app, &context, Vec::new()));
    assert_eq!(cells.len(), 5);
}

#[test]
fn a_cell_keeps_its_id_and_focus_when_scrolling_changes_the_first_visible_cell() {
    let context = egui::Context::default();
    context.enable_accesskit();
    let mut app = editor_over(&context, 200);
    let ids = |nodes: &Nodes| -> std::collections::HashMap<String, u64> {
        nodes
            .iter()
            .filter_map(|(id, node)| Some((node.label()?.to_owned(), id.0)))
            .collect()
    };
    let nodes = settle(|events| frame(&mut app, &context, events), Vec::new());
    let cells = open_cells(&nodes);
    let ordered = by_position(&cells);
    let (label, rect) = ordered[3];
    let id = ids(&nodes)[label];
    let first_width = ordered[0].1.x1 - ordered[0].1.x0;
    frame(
        &mut app,
        &context,
        vec![egui::Event::AccessKitActionRequest(
            egui::accesskit::ActionRequest {
                action: egui::accesskit::Action::Focus,
                target: egui::accesskit::NodeId(id),
                data: None,
            },
        )],
    );
    assert_eq!(
        context
            .memory(|memory| memory.focused())
            .map(|id| id.value()),
        Some(id)
    );

    let mut events = scroll_events(&cells, -(first_width + 8.0) as f32 - 1.0);
    let wheel = events.pop().expect("a wheel event");
    frame(&mut app, &context, events);
    let nodes = settle(|events| frame(&mut app, &context, events), vec![wheel]);

    let moved = open_cells(&nodes)
        .into_iter()
        .find(|(candidate, _)| candidate == label)
        .expect("the cell is still laid out")
        .1;
    assert!(
        moved.x0 < rect.x0,
        "the strip did not scroll: {rect:?} then {moved:?}"
    );
    assert_eq!(ids(&nodes)[label], id);
    assert_eq!(
        context
            .memory(|memory| memory.focused())
            .map(|id| id.value()),
        Some(id)
    );
}
