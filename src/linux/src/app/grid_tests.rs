use super::filmstrip_tests::photo;
use super::*;
use crate::library::Folder;

fn frame(context: &egui::Context, app: &mut MapleApp) {
    frame_with(context, app, Vec::new());
}

fn frame_with(context: &egui::Context, app: &mut MapleApp, events: Vec<egui::Event>) {
    let input = egui::RawInput {
        screen_rect: Some(egui::Rect::from_min_size(
            egui::Pos2::ZERO,
            egui::vec2(3840.0, 2160.0),
        )),
        events,
        ..Default::default()
    };
    let _ = context.run(input, |context| {
        app.poll(context);
        app.views(context);
    });
}

fn settle(context: &egui::Context, app: &mut MapleApp) {
    let deadline = Instant::now() + Duration::from_secs(20);
    frame(context, app);
    while !(app.thumbnail_pending.is_empty()
        && app.thumbnail_cache.len() >= app.grid_laid_out.len())
    {
        assert!(
            Instant::now() < deadline,
            "{} of {} tiles cached, {} still requested",
            app.thumbnail_cache.len(),
            app.grid_laid_out.len(),
            app.thumbnail_pending.len()
        );
        std::thread::sleep(Duration::from_millis(2));
        frame(context, app);
    }
}

fn wide_grid(context: &egui::Context) -> MapleApp {
    let mut app = MapleApp::from_context(context.clone());
    app.folder = Some(Folder {
        path: PathBuf::from("/library"),
        folders: Vec::new(),
        photos: (0..600).map(photo).collect(),
        errors: Vec::new(),
    });
    app
}

#[test]
fn a_grid_showing_more_tiles_than_the_cache_floor_settles_instead_of_refetching() {
    let context = egui::Context::default();
    let mut app = wide_grid(&context);

    settle(&context, &mut app);
    assert!(app.grid_laid_out.len() > 128, "{:?}", app.grid_laid_out);

    frame(&context, &mut app);
    assert!(app.thumbnail_pending.is_empty());
}

#[test]
fn a_thumbnail_arriving_for_a_tile_off_screen_never_evicts_one_on_screen() {
    let context = egui::Context::default();
    let mut app = wide_grid(&context);
    settle(&context, &mut app);
    let off_screen = photo(599);
    assert!(!app.grid_laid_out.contains(&599));

    assert!(app
        .thumbnails
        .request(app.thumbnail_epoch, off_screen.clone()));
    app.thumbnail_pending.insert(off_screen.path.clone());
    let deadline = Instant::now() + Duration::from_secs(20);
    while app.thumbnail_pending.contains(&off_screen.path) {
        assert!(Instant::now() < deadline, "the thumbnail never arrived");
        std::thread::sleep(Duration::from_millis(2));
        app.poll(&context);
    }

    frame(&context, &mut app);
    assert!(
        app.thumbnail_pending.is_empty(),
        "{:?}",
        app.thumbnail_pending
    );
    assert!(!app.thumbnail_cache.contains_key(&off_screen.path));
}

fn scroll_to_the_last_tiles(context: &egui::Context, app: &mut MapleApp) {
    let deadline = Instant::now() + Duration::from_secs(20);
    let mut events = vec![
        egui::Event::PointerMoved(egui::pos2(2000.0, 1000.0)),
        egui::Event::MouseWheel {
            unit: egui::MouseWheelUnit::Point,
            delta: egui::vec2(0.0, -1.0e6),
            modifiers: egui::Modifiers::NONE,
        },
    ];
    loop {
        frame_with(context, app, std::mem::take(&mut events));
        let at_the_end = app.grid_laid_out.end == 600;
        if at_the_end
            && app.thumbnail_pending.is_empty()
            && app.thumbnail_cache.len() >= app.grid_laid_out.len()
        {
            return;
        }
        assert!(
            Instant::now() < deadline,
            "the grid never settled at the end: {:?}",
            app.grid_laid_out
        );
        std::thread::sleep(Duration::from_millis(2));
    }
}

#[test]
fn opening_a_photo_ends_the_protection_of_the_grid_tiles_it_leaves_behind() {
    let context = egui::Context::default();
    let mut app = wide_grid(&context);
    scroll_to_the_last_tiles(&context, &mut app);
    assert!(!app.grid_laid_out.contains(&0), "{:?}", app.grid_laid_out);
    assert!(app.thumbnail_cache.len() > 128);

    app.browse = false;
    let deadline = Instant::now() + Duration::from_secs(20);
    frame(&context, &mut app);
    while !app.thumbnail_pending.is_empty() {
        assert!(
            Instant::now() < deadline,
            "{} filmstrip thumbnails are requested again and again",
            app.thumbnail_pending.len()
        );
        std::thread::sleep(Duration::from_millis(2));
        frame(&context, &mut app);
    }

    for _ in 0..10 {
        frame(&context, &mut app);
        assert!(
            app.thumbnail_pending.is_empty(),
            "{:?}",
            app.thumbnail_pending
        );
    }
    assert!(app.thumbnail_cache.contains_key(&photo(0).path));
}

#[test]
fn a_cloud_visit_keeps_the_local_grid_tiles_protected_for_the_return() {
    let context = egui::Context::default();
    let mut app = wide_grid(&context);
    settle(&context, &mut app);
    let laid_out = app.grid_laid_out.clone();

    app.browse = false;
    app.cloud.active = true;
    app.poll(&context);

    assert_eq!(app.grid_laid_out, laid_out);
}
