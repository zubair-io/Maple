use super::*;

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
