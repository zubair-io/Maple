use super::film_tests::{click, frame};
use super::*;

#[test]
fn pixel_scale_anchor_and_pan_clamp_follow_native_dimensions() {
    let viewport = egui::Rect::from_min_size(egui::Pos2::ZERO, egui::vec2(800.0, 600.0));
    let size = egui::vec2(4000.0, 3000.0);
    let mut zoom = zoom::ZoomCanvas::default();
    assert_eq!(zoom.image_rect(viewport, size, 2.0).size(), viewport.size());
    zoom.scale = 1.0;
    assert_eq!(
        zoom.image_rect(viewport, size, 2.0).size(),
        size / 2.0,
        "100% is one physical pixel per source pixel"
    );
    let anchor = egui::pos2(250.0, 200.0);
    let old = zoom.image_rect(viewport, size, 2.0);
    let source_point = (anchor - old.min) / old.size();
    zoom.zoom_at(1.5, anchor, viewport, size, 2.0);
    let new = zoom.image_rect(viewport, size, 2.0);
    assert!(((anchor - new.min) / new.size() - source_point).length() < 0.00001);
    zoom.pan = egui::vec2(99999.0, -99999.0);
    let clamped = zoom.image_rect(viewport, size, 2.0);
    assert!(clamped.contains_rect(viewport), "pan cannot expose a gap");
    zoom.fit();
    assert_eq!(zoom.pan, egui::Vec2::ZERO);
    assert_eq!(zoom.scale, 0.0);
    // A small source still has an actual 100% view, even when Fit enlarges it.
    zoom.scale = 1.0;
    assert_eq!(
        zoom.image_rect(viewport, egui::vec2(96.0, 64.0), 2.0)
            .size(),
        egui::vec2(48.0, 32.0)
    );
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
    assert_eq!(app.zoom.scale, 1.0);
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
    assert_eq!(app.zoom.scale, 0.0);
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
        app.zoom.scale, 1.0,
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
    assert_eq!(app.zoom.scale, 1.0);
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
    assert_eq!(app.zoom.scale, 0.0);
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
    app.zoom.scale = 0.9;
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
    app.zoom.scale = 1.0;
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
