use super::*;
use crate::app::film_tests;
use egui::accesskit::{self, NodeId};

fn entry(index: usize) -> CloudEntry {
    serde_json::from_value(serde_json::json!({
        "name": format!("{index}.dng"),
        "address": format!("library:{index}.dng"),
        "path": format!("{index}.dng"),
    }))
    .unwrap()
}

fn frame(context: &egui::Context, cloud: &mut CloudState) {
    let input = egui::RawInput {
        screen_rect: Some(egui::Rect::from_min_size(
            egui::Pos2::ZERO,
            egui::vec2(3840.0, 2160.0),
        )),
        ..Default::default()
    };
    let _ = context.run(input, |context| {
        cloud.poll(context);
        cloud.views(context, &mut true);
    });
}

fn settle(context: &egui::Context, cloud: &mut CloudState) {
    let deadline = Instant::now() + Duration::from_secs(20);
    frame(context, cloud);
    while !(cloud.pending.is_empty() && cloud.cache.len() >= cloud.laid_out.len()) {
        assert!(
            Instant::now() < deadline,
            "{} of {} tiles cached, {} still requested",
            cloud.cache.len(),
            cloud.laid_out.len(),
            cloud.pending.len()
        );
        std::thread::sleep(Duration::from_millis(2));
        frame(context, cloud);
    }
}

fn wide_grid(context: &egui::Context) -> CloudState {
    let mut cloud = CloudState::new(context.clone());
    cloud.folder = Some(CloudFolder {
        address: "library:".into(),
        parent: None,
        path: String::new(),
        folders: Vec::new(),
        images: (0..600).map(entry).collect(),
        sidecars: Vec::new(),
        next_cursor: None,
    });
    cloud
}

#[test]
fn a_grid_showing_more_tiles_than_the_cache_floor_settles_instead_of_refetching() {
    let context = egui::Context::default();
    let mut cloud = wide_grid(&context);

    settle(&context, &mut cloud);
    assert!(cloud.laid_out.len() > 128, "{:?}", cloud.laid_out);

    frame(&context, &mut cloud);
    assert!(cloud.pending.is_empty());
}

#[test]
fn a_thumbnail_arriving_for_a_tile_off_screen_never_evicts_one_on_screen() {
    let context = egui::Context::default();
    let mut cloud = wide_grid(&context);
    settle(&context, &mut cloud);
    let off_screen = entry(599);
    assert!(!cloud.laid_out.contains(&599));

    assert!(cloud.worker.image(cloud.epoch, off_screen.clone(), false));
    cloud.pending.insert(off_screen.address.clone());
    let deadline = Instant::now() + Duration::from_secs(20);
    while cloud.pending.contains(&off_screen.address) {
        assert!(Instant::now() < deadline, "the thumbnail never arrived");
        std::thread::sleep(Duration::from_millis(2));
        cloud.poll(&context);
    }

    frame(&context, &mut cloud);
    assert!(cloud.pending.is_empty(), "{:?}", cloud.pending);
    assert!(!cloud.cache.contains_key(&off_screen.address));
}

fn editing_in_a_cloud_folder(context: &egui::Context, entries: usize) -> MapleApp {
    let mut app = MapleApp::from_context(context.clone());
    app.cloud.folder = Some(CloudFolder {
        address: "library:".into(),
        parent: None,
        path: String::new(),
        folders: Vec::new(),
        images: (0..entries).map(entry).collect(),
        sidecars: Vec::new(),
        next_cursor: None,
    });
    app.cloud_editor = Some(entry(0));
    app.browse = false;
    app
}

fn strip_buttons(nodes: &[(NodeId, accesskit::Node)]) -> usize {
    nodes
        .iter()
        .filter(|(_, node)| {
            node.role() == accesskit::Role::Button
                && node.label().is_some_and(|label| label.ends_with(".dng"))
        })
        .count()
}

#[test]
fn the_cloud_filmstrip_reads_the_listing_where_it_is_stored() {
    let context = egui::Context::default();
    context.enable_accesskit();
    let mut app = editing_in_a_cloud_folder(&context, 2_000);
    let stored = app.cloud.folder.as_ref().unwrap().images.as_ptr();
    assert_eq!(app.cloud.photos().as_ptr(), stored);

    let nodes = film_tests::frame(&mut app, &context, Vec::new());
    assert_eq!(strip_buttons(&nodes), 2_000);
}

#[test]
#[ignore = "prints the per-frame time of the cloud filmstrip; run with --nocapture"]
fn cloud_filmstrip_frame_time_over_two_thousand_entries() {
    let context = egui::Context::default();
    context.enable_accesskit();
    let mut app = editing_in_a_cloud_folder(&context, 2_000);
    film_tests::frame(&mut app, &context, Vec::new());
    let mut micros: Vec<u128> = (0..30)
        .map(|_| {
            let started = Instant::now();
            film_tests::frame(&mut app, &context, Vec::new());
            started.elapsed().as_micros()
        })
        .collect();
    micros.sort_unstable();
    println!(
        "cloud-filmstrip-frame entries=2000 min_us={} median_us={}",
        micros[0],
        micros[micros.len() / 2]
    );
}
