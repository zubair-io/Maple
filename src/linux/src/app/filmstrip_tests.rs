use super::film_tests::frame;
use super::*;
use crate::library::{Folder, MediaKind};
use egui::accesskit::NodeId;

/// The full layout adds up to 300,000 points in f32, where one step is 0.03; far cells get 2e-6 more per point.
const X_TOLERANCE: f64 = 0.25;

pub(super) fn photo(index: usize) -> Photo {
    Photo {
        path: PathBuf::from(format!(
            "/library/IMG_{index:05}_{}.dng",
            "x".repeat(index % 9)
        )),
        kind: MediaKind::Raw,
        modified: std::time::SystemTime::UNIX_EPOCH,
        size: 1,
    }
}

pub(super) fn editor_over(context: &egui::Context, count: usize) -> MapleApp {
    let mut app = MapleApp::from_context(context.clone());
    let photos: Vec<Photo> = (0..count).map(photo).collect();
    app.thumbnail_pending = photos.iter().map(|photo| photo.path.clone()).collect();
    app.folder = Some(Folder {
        path: PathBuf::from("/library"),
        folders: Vec::new(),
        photos,
        errors: Vec::new(),
    });
    app.browse = false;
    app
}

#[test]
#[ignore = "prints the per-frame time of the editor filmstrip; run with --nocapture"]
fn editor_filmstrip_frame_time_over_two_thousand_photos() {
    let context = egui::Context::default();
    context.enable_accesskit();
    let mut app = editor_over(&context, 2_000);
    frame(&mut app, &context, Vec::new());
    let mut micros: Vec<u128> = (0..30)
        .map(|_| {
            let started = Instant::now();
            frame(&mut app, &context, Vec::new());
            started.elapsed().as_micros()
        })
        .collect();
    micros.sort_unstable();
    println!(
        "editor-filmstrip-frame photos=2000 min_us={} median_us={}",
        micros[0],
        micros[micros.len() / 2]
    );
}

pub(super) fn texture_sizes(context: &egui::Context, index: usize) -> egui::TextureHandle {
    let [width, height] = [[256, 171], [256, 192], [256, 144], [171, 256], [256, 256]][index % 5];
    context.load_texture(
        format!("film-{index}"),
        egui::ColorImage::new([width, height], egui::Color32::GRAY),
        egui::TextureOptions::LINEAR,
    )
}

pub(super) fn mixed_states(context: &egui::Context, app: &mut MapleApp) {
    let paths: Vec<PathBuf> = app
        .folder
        .as_ref()
        .unwrap()
        .photos
        .iter()
        .map(|p| p.path.clone())
        .collect();
    for (index, path) in paths.into_iter().enumerate() {
        match index % 11 {
            0 | 3 | 7 => {
                app.thumbnail_cache
                    .insert(path, Ok(texture_sizes(context, index)));
            }
            5 => {
                app.thumbnail_cache.insert(path, Err("no preview".into()));
            }
            _ => {}
        }
    }
    app.filmstrip.thumbnails_changed();
}

pub(super) type Nodes = Vec<(NodeId, egui::accesskit::Node)>;

pub(super) fn label_of_photo(index: usize) -> String {
    format!(
        "Open {}",
        photo(index).path.file_name().unwrap().to_string_lossy()
    )
}

pub(super) fn open_cells(nodes: &Nodes) -> Vec<(String, egui::accesskit::Rect)> {
    nodes
        .iter()
        .filter_map(|(_, node)| {
            let label = node.label()?;
            label.starts_with("Open ").then_some(())?;
            Some((label.to_owned(), node.bounds()?))
        })
        .collect()
}

pub(super) fn scroll_events(
    cells: &[(String, egui::accesskit::Rect)],
    delta: f32,
) -> Vec<egui::Event> {
    let rect = cells[0].1;
    vec![
        egui::Event::PointerMoved(egui::pos2(100.0, ((rect.y0 + rect.y1) / 2.0) as f32)),
        egui::Event::MouseWheel {
            unit: egui::MouseWheelUnit::Point,
            delta: egui::vec2(delta, 0.0),
            modifiers: egui::Modifiers::NONE,
        },
    ]
}

fn reference_frame(
    context: &egui::Context,
    app: &MapleApp,
    events: Vec<egui::Event>,
) -> (Nodes, egui::Rect) {
    let input = egui::RawInput {
        screen_rect: Some(egui::Rect::from_min_size(
            egui::Pos2::ZERO,
            egui::vec2(1280.0, 800.0),
        )),
        events,
        ..Default::default()
    };
    let clip = std::cell::Cell::new(egui::Rect::NOTHING);
    let nodes = context
        .run(input, |context| {
            egui::TopBottomPanel::bottom("status")
                .frame(super::style::panel("surface"))
                .show(context, |ui| {
                    ui.label(
                        egui::RichText::new(&app.status)
                            .small()
                            .color(super::style::color("text_muted")),
                    );
                });
            egui::TopBottomPanel::bottom("filmstrip")
                .frame(super::style::panel("surface"))
                .show(context, |ui| {
                    egui::ScrollArea::horizontal().show(ui, |ui| {
                        clip.set(ui.clip_rect());
                        ui.horizontal(|ui| {
                            for photo in &app.folder.as_ref().unwrap().photos {
                                let name =
                                    photo.path.file_name().unwrap_or_default().to_string_lossy();
                                let response = match app.thumbnail_cache.get(&photo.path) {
                                    Some(Ok(texture)) => ui.add(
                                        egui::Image::new(texture)
                                            .fit_to_exact_size(egui::vec2(72.0, 46.0))
                                            .rounding(5.0)
                                            .sense(egui::Sense::click()),
                                    ),
                                    Some(Err(error)) => {
                                        ui.button("Preview unavailable").on_hover_text(error)
                                    }
                                    None => ui.button(name.as_ref()),
                                }
                                .on_hover_text(name.as_ref());
                                response.widget_info(|| {
                                    egui::WidgetInfo::labeled(
                                        egui::WidgetType::Button,
                                        response.enabled(),
                                        format!("Open {name}"),
                                    )
                                });
                            }
                        });
                    });
                });
        })
        .platform_output
        .accesskit_update
        .expect("accessible reference strip")
        .nodes;
    (nodes, clip.get())
}

pub(super) fn settle<T>(
    mut step: impl FnMut(Vec<egui::Event>) -> T,
    events: Vec<egui::Event>,
) -> T {
    let mut last = step(events);
    for _ in 0..40 {
        last = step(Vec::new());
    }
    last
}

#[test]
fn the_filmstrip_lays_out_the_visible_cells_not_every_photo() {
    let context = egui::Context::default();
    context.enable_accesskit();
    let mut app = editor_over(&context, 2_000);
    mixed_states(&context, &mut app);
    let cells = open_cells(&frame(&mut app, &context, Vec::new()));
    assert!(!cells.is_empty());
    assert!(
        cells.len() < 40,
        "{} cells laid out for 2,000 photos",
        cells.len()
    );
}

#[test]
fn the_filmstrip_lays_out_the_cells_of_the_full_layout_that_reach_the_clip_rect_where_they_were() {
    let real_context = egui::Context::default();
    real_context.enable_accesskit();
    let mut app = editor_over(&real_context, 2_000);
    mixed_states(&real_context, &mut app);
    let reference_context = egui::Context::default();
    reference_context.enable_accesskit();
    super::style::apply(&reference_context);
    let mut real = open_cells(&frame(&mut app, &real_context, Vec::new()));
    let (nodes, _) = reference_frame(&reference_context, &app, Vec::new());
    let mut reference = open_cells(&nodes);
    for delta in [0.0, -300.0, -1_234.0, -60_000.0, -1.0e9] {
        let real_events = scroll_events(&real, delta);
        let reference_events = scroll_events(&reference, delta);
        real = open_cells(&settle(
            |events| frame(&mut app, &real_context, events),
            real_events,
        ));
        let (nodes, clip) = settle(
            |events| reference_frame(&reference_context, &app, events),
            reference_events,
        );
        reference = open_cells(&nodes);
        let reaching = |tolerance: f64| -> std::collections::BTreeSet<&str> {
            reference
                .iter()
                .filter(|(_, rect)| {
                    rect.x1 >= f64::from(clip.min.x) - tolerance
                        && rect.x0 <= f64::from(clip.max.x) + tolerance
                })
                .map(|(label, _)| label.as_str())
                .collect()
        };
        let laid_out: std::collections::BTreeSet<&str> =
            real.iter().map(|(label, _)| label.as_str()).collect();
        assert!(
            reaching(-X_TOLERANCE).is_subset(&laid_out),
            "delta {delta}: missing {:?}",
            reaching(-X_TOLERANCE)
                .difference(&laid_out)
                .collect::<Vec<_>>()
        );
        let mut ordered: Vec<&(String, egui::accesskit::Rect)> = reference.iter().collect();
        ordered.sort_by(|a, b| a.1.x0.total_cmp(&b.1.x0));
        let strict = reaching(-X_TOLERANCE);
        let first = ordered
            .iter()
            .position(|(label, _)| strict.contains(label.as_str()));
        let last = ordered
            .iter()
            .rposition(|(label, _)| strict.contains(label.as_str()));
        let (first, last) = first.zip(last).expect("some cells reach the clip rect");
        for neighbour in [
            first.checked_sub(1),
            Some(last + 1).filter(|&n| n < ordered.len()),
        ]
        .into_iter()
        .flatten()
        {
            assert!(
                laid_out.contains(ordered[neighbour].0.as_str()),
                "delta {delta}: the cell beside the clip rect, {}, is not laid out",
                ordered[neighbour].0
            );
        }
        for end in [label_of_photo(0), label_of_photo(1_999)] {
            assert!(
                laid_out.contains(end.as_str()),
                "delta {delta}: {end} is not laid out"
            );
        }
        let allowed = reaching(X_TOLERANCE);
        let beyond: Vec<_> = laid_out.difference(&allowed).collect();
        assert!(
            beyond.len() <= 4,
            "delta {delta}: more than two neighbours and the two ends beyond the clip rect: {beyond:?}"
        );
        for (label, rect) in &real {
            let (_, expected) = reference
                .iter()
                .find(|(other, _)| other == label)
                .expect("the full layout has every cell");
            assert!(
                (rect.x0 - expected.x0).abs() < X_TOLERANCE + rect.x0.abs() * 2e-6
                    && (rect.x1 - expected.x1).abs() < X_TOLERANCE + rect.x1.abs() * 2e-6
                    && (rect.y0 - expected.y0).abs() < 0.01
                    && (rect.y1 - expected.y1).abs() < 0.01,
                "delta {delta}: {label} is {rect:?}, the full layout has {expected:?}"
            );
        }
    }
    let last = &app.folder.as_ref().unwrap().photos[1_999];
    let last_name = last.path.file_name().unwrap().to_string_lossy();
    assert!(real
        .iter()
        .any(|(label, _)| *label == format!("Open {last_name}")));
}

#[test]
fn clicking_a_visible_cell_selects_the_photo_it_names() {
    let context = egui::Context::default();
    context.enable_accesskit();
    let mut app = editor_over(&context, 2_000);
    mixed_states(&context, &mut app);
    let cells = open_cells(&frame(&mut app, &context, Vec::new()));
    let events = scroll_events(&cells, -60_000.0);
    let cells = open_cells(&settle(|events| frame(&mut app, &context, events), events));
    let (label, _) = &cells[3];
    super::film_tests::click(&mut app, &context, label);
    let selected = app.selected.as_ref().expect("a photo was selected");
    assert_eq!(
        format!(
            "Open {}",
            selected.path.file_name().unwrap().to_string_lossy()
        ),
        *label
    );
    assert_ne!(selected.path, app.folder.as_ref().unwrap().photos[3].path);
}

fn arrival_frame_micros(remeasure_names: bool) -> Vec<u128> {
    let context = egui::Context::default();
    context.enable_accesskit();
    let mut app = editor_over(&context, 2_000);
    frame(&mut app, &context, Vec::new());
    let mut micros: Vec<u128> = (0..30)
        .map(|arrival| {
            app.thumbnail_cache
                .insert(photo(arrival).path, Ok(texture_sizes(&context, arrival)));
            app.filmstrip.thumbnails_changed();
            if remeasure_names {
                app.filmstrip.photos_changed();
            }
            let started = Instant::now();
            frame(&mut app, &context, Vec::new());
            started.elapsed().as_micros()
        })
        .collect();
    micros.sort_unstable();
    micros
}

#[test]
#[ignore = "prints the time of a filmstrip frame in which a thumbnail arrives; run with --nocapture"]
fn editor_filmstrip_arrival_frame_time_over_two_thousand_photos() {
    let micros = arrival_frame_micros(false);
    println!(
        "editor-filmstrip-arrival-frame photos=2000 min_us={} median_us={}",
        micros[0],
        micros[micros.len() / 2]
    );
}

#[test]
#[ignore = "prints the arrival frame time with every name measured again, as before names were cached; run with --nocapture"]
fn editor_filmstrip_arrival_frame_time_with_every_name_measured_again() {
    let micros = arrival_frame_micros(true);
    println!(
        "editor-filmstrip-arrival-frame-names-measured-again photos=2000 min_us={} median_us={}",
        micros[0],
        micros[micros.len() / 2]
    );
}
