use super::film_tests::{click, frame};
use super::*;

#[test]
fn rotated_crop_uses_native_viewport_patch_and_preserves_imported_xmp() {
    for angle in [90.0, 3.5] {
        let directory = tempfile::tempdir().unwrap();
        let bytes = raw_core::png::encode(3200, 64, &[90; 3200 * 64 * 3]).unwrap();
        let path = directory.path().join("crop.png");
        std::fs::write(&path, &bytes).unwrap();
        let model = raw_core::AdjustmentModel {
            crop: raw_core::types::Crop {
                left: 0.25,
                right: 0.75,
                angle,
                ..raw_core::types::Crop::IDENTITY
            },
            ..Default::default()
        };
        let attributes = raw_core::xmp::serialize(&model);
        let xml = format!(
            r#"<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><rdf:Description xmlns:crs="http://ns.adobe.com/camera-raw-settings/1.0/" xmlns:papp="http://ns.justmaple.app/photo/1.0/"{attributes}/></rdf:RDF></x:xmpmeta>"#
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
        assert_eq!(app.document.as_ref().unwrap().model.crop, model.crop);
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
            .expect("native orthogonal crop patch");
        assert_eq!(texture.size(), [rect.src_w as usize, rect.src_h as usize]);
        if angle == 90.0 {
            assert_eq!(rect.src_w, 64);
            assert!(rect.src_h < 1600, "native viewport window");
        } else {
            assert_eq!(rect.src_h, 64);
            assert!(rect.src_w < 1600, "native straighten viewport window");
        }
        assert!(app.zoom.error.is_none(), "{:?}", app.zoom.error);
        assert!(app.zoom.resolution_status.is_none());
        assert!(!app.zoom.refining());
        assert!(app.dirty.is_none() && app.history.is_empty());
        app.worker.finish();
        assert_eq!(
            std::fs::read(path.with_extension("xmp")).unwrap(),
            xml.as_bytes()
        );
        assert_eq!(std::fs::read(path).unwrap(), bytes);
    }
}

#[test]
fn a_density_change_keeps_the_centred_image_point_centred() {
    let viewport = egui::Rect::from_min_size(egui::Pos2::ZERO, egui::vec2(800.0, 600.0));
    let at_density = |pixels_per_point| zoom::CanvasGeometry {
        viewport,
        source: egui::vec2(4000.0, 3000.0),
        pixels_per_point,
    };
    let centred_source_point = |rect: egui::Rect| (viewport.center() - rect.min) / rect.size();
    let mut zoom = zoom::ZoomCanvas::default();
    zoom.image_rect(&at_density(2.0));
    zoom.zoom_to(1.0);
    zoom.image_rect(&at_density(2.0));
    zoom.drag_started();
    zoom.drag(egui::vec2(400.0, 0.0), &at_density(2.0));
    zoom.drag_ended();
    let before = centred_source_point(zoom.image_rect(&at_density(2.0)));
    let after = centred_source_point(zoom.image_rect(&at_density(2.2)));
    assert!(
        (after - before).length() < 0.00001,
        "the photo moved with no pointer motion: {before:?} -> {after:?}"
    );
    assert!((zoom.pan().x - 400.0 * 2.0 / 2.2).abs() < 0.001);
}
