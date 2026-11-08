use super::film_tests::{click, frame};
use super::*;

fn canvas_geometry(source: egui::Vec2) -> zoom::CanvasGeometry {
    zoom::CanvasGeometry {
        viewport: egui::Rect::from_min_size(egui::Pos2::ZERO, egui::vec2(800.0, 600.0)),
        source,
        pixels_per_point: 2.0,
    }
}

#[test]
fn pixel_scale_anchor_and_pan_clamp_follow_native_dimensions() {
    let geometry = canvas_geometry(egui::vec2(4000.0, 3000.0));
    let viewport = geometry.viewport;
    let size = geometry.source;
    let mut zoom = zoom::ZoomCanvas::default();
    assert_eq!(zoom.image_rect(&geometry).size(), viewport.size());
    zoom.zoom_to(1.0);
    assert_eq!(
        zoom.image_rect(&geometry).size(),
        size / 2.0,
        "100% is one physical pixel per source pixel"
    );
    let anchor = egui::pos2(250.0, 200.0);
    let old = zoom.image_rect(&geometry);
    let source_point = (anchor - old.min) / old.size();
    zoom.zoom_at(1.5, anchor, &geometry);
    let new = zoom.image_rect(&geometry);
    assert!(((anchor - new.min) / new.size() - source_point).length() < 0.00001);
    zoom.drag(egui::vec2(99999.0, -99999.0), &geometry);
    let clamped = zoom.image_rect(&geometry);
    assert!(clamped.contains_rect(viewport), "pan cannot expose a gap");
    zoom.drag_ended();
    zoom.fit();
    assert_eq!(zoom.pan(), egui::Vec2::ZERO);
    assert_eq!(zoom.scale(), 0.0);
    // A small source still has an actual 100% view, even when Fit enlarges it.
    zoom.zoom_to(1.0);
    assert_eq!(
        zoom.image_rect(&canvas_geometry(egui::vec2(96.0, 64.0)))
            .size(),
        egui::vec2(48.0, 32.0)
    );
}

#[test]
fn drag_frames_with_layout_between_them_pan_cumulatively() {
    let geometry = canvas_geometry(egui::vec2(4000.0, 3000.0));
    let mut zoom = zoom::ZoomCanvas::default();
    zoom.zoom_to(1.0);
    zoom.image_rect(&geometry);
    zoom.drag_started();
    for (delta, expected) in [(10.0, 10.0), (10.0, 20.0), (0.0, 20.0), (5.0, 25.0)] {
        zoom.drag(egui::vec2(delta, 0.0), &geometry);
        zoom.image_rect(&geometry);
        assert_eq!(zoom.pan(), egui::vec2(expected, 0.0));
    }
    zoom.drag_ended();
    zoom.image_rect(&geometry);
    zoom.drag_started();
    zoom.drag(egui::vec2(-5.0, 0.0), &geometry);
    zoom.image_rect(&geometry);
    assert_eq!(
        zoom.pan(),
        egui::vec2(20.0, 0.0),
        "the next drag starts from the release"
    );
}

#[test]
fn shared_model_stops_floor_and_double_click_anchor() {
    let geometry = canvas_geometry(egui::vec2(4000.0, 2000.0));
    let mut zoom = zoom::ZoomCanvas::default();
    let fit = zoom.image_rect(&geometry);
    assert_eq!(fit.width(), 800.0, "fit letterboxes the wide image");

    zoom.zoom_at(0.01, geometry.viewport.center(), &geometry);
    assert_eq!(
        zoom.image_rect(&geometry).width(),
        400.0,
        "zoom-out stops at half of fit"
    );
    zoom.zoom_at(100.0, geometry.viewport.center(), &geometry);
    assert_eq!(
        zoom.scale(),
        0.0,
        "zooming in from below fit settles on fit"
    );

    zoom.fill();
    let fill = zoom.image_rect(&geometry);
    assert_eq!(fill.height(), 600.0, "fill covers the viewport height");
    assert!(fill.contains_rect(geometry.viewport));

    zoom.fit();
    let tap = egui::pos2(600.0, 250.0);
    let before = zoom.image_rect(&geometry);
    let source_point = (tap - before.min) / before.size();
    zoom.double_click(tap, &geometry);
    assert_eq!(zoom.scale(), 1.0, "editor double-click toggles to 100%");
    let after = zoom.image_rect(&geometry);
    assert!(((tap - after.min) / after.size() - source_point).length() < 0.00001);
    zoom.double_click(tap, &geometry);
    assert_eq!(zoom.scale(), 0.0);
    assert_eq!(zoom.pan(), egui::Vec2::ZERO);
}

#[test]
fn accessible_actual_size_develops_native_patch_and_fit_releases_it() {
    let directory = tempfile::tempdir().unwrap();
    let source = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../test-fixtures/batch-transfer/source.dng");
    let bytes = std::fs::read(source).unwrap();
    let path = directory.path().join("photo.dng");
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
        if app.texture.is_some() && app.zoom.native.is_some() {
            break;
        }
        std::thread::sleep(Duration::from_millis(5));
    }
    let model = app.document.as_ref().unwrap().model.clone();
    click(&mut app, &context, "100%");
    for _ in 0..300 {
        frame(&mut app, &context, Vec::new());
        if app.zoom.patch.is_some() {
            break;
        }
        std::thread::sleep(Duration::from_millis(5));
    }
    assert_eq!(app.zoom.scale(), 1.0);
    let (rect, texture) = app
        .zoom
        .patch
        .as_ref()
        .expect("real native patch from worker");
    assert_eq!(texture.size(), [rect.src_w as usize, rect.src_h as usize]);
    assert!(app.zoom.base.is_some());
    assert!(
        !app.zoom.refining(),
        "completed patch clears refine progress"
    );
    assert!(app.zoom.error.is_none(), "{:?}", app.zoom.error);
    assert_eq!(
        app.document.as_ref().unwrap().model,
        model,
        "zoom must not edit XMP"
    );
    assert!(app.history.is_empty());
    assert!(app.dirty.is_none());
    let generation = app.zoom.generation;
    click(&mut app, &context, "Fit");
    assert_eq!(app.zoom.scale(), 0.0);
    assert!(app.zoom.patch.is_none() && app.zoom.base.is_none());
    assert!(
        app.zoom.generation > generation,
        "Fit invalidates old detail results"
    );
    frame(
        &mut app,
        &context,
        vec![egui::Event::Key {
            key: egui::Key::Z,
            physical_key: Some(egui::Key::Z),
            pressed: true,
            repeat: false,
            modifiers: egui::Modifiers::NONE,
        }],
    );
    assert_eq!(
        app.zoom.scale(),
        1.0,
        "a focused Fit button must not block the Z shortcut"
    );
    assert_eq!(std::fs::read(path).unwrap(), bytes);
    assert!(!directory.path().join("photo.xmp").exists());
}

#[test]
fn raster_actual_size_control_uses_source_dimensions_without_editing_sidecar() {
    let directory = tempfile::tempdir().unwrap();
    let bytes = raw_core::png::encode(80, 60, &[90; 80 * 60 * 3]).unwrap();
    let path = directory.path().join("photo.png");
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
        if app.texture.is_some() && app.zoom.native.is_some() {
            break;
        }
        std::thread::sleep(Duration::from_millis(5));
    }
    assert_eq!(app.zoom.native, Some((80, 60)));
    let model = app.document.as_ref().unwrap().model.clone();
    click(&mut app, &context, "100%");
    assert_eq!(app.zoom.scale(), 1.0);
    for _ in 0..300 {
        frame(&mut app, &context, Vec::new());
        if app.zoom.patch.is_some() {
            break;
        }
        std::thread::sleep(Duration::from_millis(5));
    }
    let (rect, texture) = app.zoom.patch.as_ref().expect("native raster patch");
    assert_eq!(texture.size(), [rect.src_w as usize, rect.src_h as usize]);
    assert!(app.zoom.base.is_some());
    assert!(!app.zoom.refining());
    assert!(app.zoom.error.is_none(), "{:?}", app.zoom.error);
    click(&mut app, &context, "Fit");
    assert_eq!(app.zoom.scale(), 0.0);
    assert_eq!(app.document.as_ref().unwrap().model, model);
    assert_eq!(std::fs::read(&path).unwrap(), bytes);
    assert!(!path.with_extension("xmp").exists());
    app.worker.finish();
}

#[test]
fn below_native_zoom_refines_above_initial_preview_and_native_zoom_replaces_it() {
    let directory = tempfile::tempdir().unwrap();
    let bytes = raw_core::png::encode(2048, 64, &[90; 2048 * 64 * 3]).unwrap();
    let path = directory.path().join("wide.png");
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
        if app.texture.is_some() && app.zoom.native.is_some() {
            break;
        }
        std::thread::sleep(Duration::from_millis(5));
    }
    assert_eq!(app.texture.as_ref().unwrap().size()[0], 1600);
    let model = app.document.as_ref().unwrap().model.clone();
    app.zoom.zoom_to(0.9);
    for _ in 0..400 {
        frame(&mut app, &context, Vec::new());
        if app.zoom.patch.is_some() {
            break;
        }
        std::thread::sleep(Duration::from_millis(5));
    }
    let (rect, texture) = app
        .zoom
        .patch
        .as_ref()
        .expect("below-native refinement from real worker");
    assert_eq!((rect.src_w, rect.src_h), (2048, 64));
    assert!(rect.out_w < rect.src_w);
    assert!(
        texture.size()[0] > 1600,
        "must develop beyond initial preview"
    );
    assert!(!app.zoom.refining());
    let generation = app.zoom.generation;
    app.zoom.zoom_to(1.0);
    for _ in 0..400 {
        frame(&mut app, &context, Vec::new());
        if app
            .zoom
            .patch
            .as_ref()
            .is_some_and(|(r, _)| r.src_w == r.out_w)
        {
            break;
        }
        std::thread::sleep(Duration::from_millis(5));
    }
    let (rect, texture) = app.zoom.patch.as_ref().unwrap();
    assert_eq!(
        rect.src_w, rect.out_w,
        "a scaled patch cannot satisfy native refinement"
    );
    assert_eq!(texture.size(), [rect.out_w as usize, rect.out_h as usize]);
    assert!(app.zoom.generation > generation);
    assert_eq!(app.document.as_ref().unwrap().model, model);
    assert!(app.dirty.is_none() && app.history.is_empty());
    app.zoom.fit();
    frame(&mut app, &context, Vec::new());
    assert!(app.zoom.patch.is_none());
    assert_eq!(std::fs::read(&path).unwrap(), bytes);
    assert!(!path.with_extension("xmp").exists());
    app.worker.finish();
}

#[test]
fn imported_crop_perspective_and_dehaze_refine_at_native_zoom_without_writing() {
    let directory = tempfile::tempdir().unwrap();
    let bytes = raw_core::png::encode(80, 60, &[90; 80 * 60 * 3]).unwrap();
    let path = directory.path().join("geometry.png");
    std::fs::write(&path, &bytes).unwrap();
    let mut imported = crate::sidecar::SidecarDocument::default();
    imported.model.crop.left = 0.25;
    imported.model.crop.right = 0.75;
    imported.model.crop.angle = 90.0;
    imported.model.perspective_vertical = 15.0;
    imported.model.dehaze = 10.0;
    let attributes = raw_core::xmp::serialize(&imported.model);
    let xml = format!(
        r#"<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><rdf:Description xmlns:crs="http://ns.adobe.com/camera-raw-settings/1.0/" xmlns:papp="http://ns.justmaple.app/photo/1.0/"{attributes}/></rdf:RDF></x:xmpmeta>"#
    );
    assert_eq!(
        crate::sidecar::SidecarDocument::parse(&xml)
            .unwrap()
            .model
            .crop,
        imported.model.crop
    );
    std::fs::write(path.with_extension("xmp"), &xml).unwrap();
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
        if app.texture.is_some() && app.zoom.native.is_some() {
            break;
        }
        std::thread::sleep(Duration::from_millis(5));
    }
    let model = app.document.as_ref().unwrap().model.clone();
    click(&mut app, &context, "100%");
    for _ in 0..400 {
        frame(&mut app, &context, Vec::new());
        if app.zoom.patch.is_some() {
            break;
        }
        std::thread::sleep(Duration::from_millis(5));
    }
    let (rect, texture) = app
        .zoom
        .patch
        .as_ref()
        .expect("whole-frame geometry refinement");
    assert_eq!((rect.src_w, rect.src_h), (60, 40));
    assert_eq!(texture.size(), [60, 40]);
    assert!(app.zoom.error.is_none(), "{:?}", app.zoom.error);
    assert!(!app.zoom.refining());
    assert_eq!(app.document.as_ref().unwrap().model, model);
    assert!(app.dirty.is_none() && app.history.is_empty());
    app.worker.finish();
    assert_eq!(std::fs::read(&path).unwrap(), bytes);
    assert_eq!(
        std::fs::read_to_string(path.with_extension("xmp")).unwrap(),
        xml
    );
}

struct ZoomFrame {
    steps: Vec<f32>,
    smoothed: f32,
}

fn zoom_frames(frames: Vec<Vec<egui::Event>>) -> Vec<ZoomFrame> {
    let context = egui::Context::default();
    frames
        .into_iter()
        .enumerate()
        .map(|(index, events)| {
            let input = egui::RawInput {
                screen_rect: Some(egui::Rect::from_min_size(
                    egui::Pos2::ZERO,
                    egui::vec2(1000.0, 800.0),
                )),
                time: Some(index as f64 / 60.0),
                events,
                ..Default::default()
            };
            let mut frame = ZoomFrame {
                steps: Vec::new(),
                smoothed: 1.0,
            };
            let _ = context.run(input, |context| {
                frame.steps = zoom::zoom_steps(context);
                frame.smoothed = context.input(|i| i.zoom_delta());
            });
            frame
        })
        .collect()
}

fn wheel(unit: egui::MouseWheelUnit, delta_y: f32, modifiers: egui::Modifiers) -> egui::Event {
    egui::Event::MouseWheel {
        unit,
        delta: egui::vec2(0.0, delta_y),
        modifiers,
    }
}

fn ctrl_notch(direction: f32) -> egui::Event {
    wheel(egui::MouseWheelUnit::Line, direction, egui::Modifiers::CTRL)
}

fn below_fit_canvas() -> (zoom::CanvasGeometry, zoom::ZoomCanvas) {
    let geometry = zoom::CanvasGeometry {
        viewport: egui::Rect::from_min_size(egui::Pos2::ZERO, egui::vec2(1000.0, 800.0)),
        source: egui::vec2(6000.0, 4000.0),
        pixels_per_point: 1.0,
    };
    let mut zoom = zoom::ZoomCanvas::default();
    zoom.image_rect(&geometry);
    zoom.zoom_at(0.9, geometry.viewport.center(), &geometry);
    assert!(zoom.scale() > 0.0, "set up below fit");
    (geometry, zoom)
}

fn one_notch_then_idle_frames() -> Vec<ZoomFrame> {
    let mut frames = vec![vec![ctrl_notch(1.0)]];
    frames.extend(std::iter::repeat_n(Vec::new(), 12));
    zoom_frames(frames)
}

#[test]
fn one_wheel_notch_toward_fit_from_below_stops_at_fit() {
    let (geometry, mut zoom) = below_fit_canvas();
    for factor in one_notch_then_idle_frames()
        .into_iter()
        .flat_map(|frame| frame.steps)
    {
        zoom.zoom_at(factor, geometry.viewport.center(), &geometry);
        zoom.image_rect(&geometry);
    }
    assert_eq!(zoom.scale(), 0.0, "the notch lands on fit and stays there");
}

#[test]
fn egui_smoothed_zoom_delta_would_carry_the_same_notch_past_fit() {
    let (geometry, mut zoom) = below_fit_canvas();
    let frames = one_notch_then_idle_frames();
    assert!(
        frames[1..].iter().any(|frame| frame.smoothed != 1.0),
        "egui spreads one notch over later frames"
    );
    for frame in &frames {
        if frame.smoothed != 1.0 {
            zoom.zoom_at(frame.smoothed, geometry.viewport.center(), &geometry);
            zoom.image_rect(&geometry);
        }
    }
    assert!(zoom.scale() > 0.0, "the smoothed tail zooms past fit");
}

#[test]
fn zoom_steps_are_one_per_wheel_event_and_pinch() {
    let context = egui::Context::default();
    let (line_speed, zoom_speed) = context.options(|o| (o.line_scroll_speed, o.scroll_zoom_speed));
    let notch = (zoom_speed * line_speed).exp();
    let steps: Vec<_> = zoom_frames(vec![
        vec![ctrl_notch(1.0), ctrl_notch(-1.0)],
        vec![egui::Event::Zoom(1.25)],
        Vec::new(),
    ])
    .into_iter()
    .map(|frame| frame.steps)
    .collect();
    assert_eq!(steps[0].len(), 2);
    assert!((steps[0][0] - notch).abs() < 1e-5);
    assert!((steps[0][1] - 1.0 / notch).abs() < 1e-5);
    assert_eq!(steps[1], vec![1.25]);
    assert!(steps[2].is_empty(), "no momentum after the events");
}

#[test]
fn zoom_steps_cover_point_units_and_ignore_plain_and_shift_scroll() {
    let steps = &zoom_frames(vec![vec![
        wheel(egui::MouseWheelUnit::Point, 20.0, egui::Modifiers::CTRL),
        wheel(egui::MouseWheelUnit::Line, 1.0, egui::Modifiers::NONE),
        wheel(
            egui::MouseWheelUnit::Line,
            1.0,
            egui::Modifiers::CTRL | egui::Modifiers::SHIFT,
        ),
    ]])[0]
        .steps;
    assert_eq!(steps.len(), 1);
    let zoom_speed = egui::Context::default().options(|o| o.scroll_zoom_speed);
    assert!((steps[0] - (20.0 * zoom_speed).exp()).abs() < 1e-5);
}
