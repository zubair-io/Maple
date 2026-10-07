use maple_linux::{
    controls::Control,
    jobs::{Command, Event, Worker},
    library::Folder,
};
use std::{path::Path, time::Duration};

fn receive(worker: &Worker) -> Event {
    worker
        .events
        .recv_timeout(Duration::from_secs(120))
        .expect("worker completion")
}

#[test]
fn native_worker_opens_renders_and_persists_real_raw_without_touching_original() {
    let root = tempfile::tempdir().unwrap();
    let original = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../apple/MapleUITests/Fixtures/synthetic/grey-l018-rggb.dng");
    let bytes = std::fs::read(original).unwrap();
    let path = root.path().join("grey.dng");
    std::fs::write(&path, &bytes).unwrap();
    let photo = Folder::scan(root.path()).unwrap().photos.remove(0);
    let mut worker = Worker::new(eframe::egui::Context::default());
    worker.send(Command::Open(7, photo));
    let mut document = match receive(&worker) {
        Event::Opened(7, Ok((document, _))) => *document,
        _ => panic!("open failed"),
    };
    Control::Exposure.set(&mut document.model, 1.0).unwrap();
    worker.send(Command::Render(7, 2, document.model.clone()));
    let before = match receive(&worker) {
        Event::Rendered(7, 2, Ok(image)) => image,
        _ => panic!("render failed"),
    };
    assert!(before.size[0] > 0 && before.size[1] > 0);
    worker.send(Command::Save(7, document));
    assert!(matches!(receive(&worker), Event::Saved(7, Ok(()))));
    let photo = Folder::scan(root.path()).unwrap().photos.remove(0);
    worker.send(Command::Open(8, photo));
    let document = match receive(&worker) {
        Event::Opened(8, Ok((document, _))) => *document,
        _ => panic!("reopen failed"),
    };
    assert_eq!(document.model.exposure, 1.0);
    worker.send(Command::Render(8, 1, document.model));
    let after = match receive(&worker) {
        Event::Rendered(8, 1, Ok(image)) => image,
        _ => panic!("rerender failed"),
    };
    assert_eq!(before.pixels, after.pixels);
    assert_eq!(std::fs::read(path).unwrap(), bytes);
    worker.finish();
}

#[test]
fn native_worker_rejects_external_xmp_change_and_keeps_external_bytes() {
    let root = tempfile::tempdir().unwrap();
    let source = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../apple/MapleUITests/Fixtures/synthetic/grey-l018-rggb.dng");
    let path = root.path().join("grey.dng");
    std::fs::copy(source, &path).unwrap();
    let mut worker = Worker::new(eframe::egui::Context::default());
    worker.send(Command::Open(
        1,
        Folder::scan(root.path()).unwrap().photos.remove(0),
    ));
    let document = match receive(&worker) {
        Event::Opened(1, Ok((document, _))) => *document,
        _ => panic!("open failed"),
    };
    std::fs::write(path.with_extension("xmp"), "external contents").unwrap();
    worker.send(Command::Save(1, document));
    assert!(matches!(receive(&worker), Event::Saved(1, Err(_))));
    assert_eq!(
        std::fs::read_to_string(path.with_extension("xmp")).unwrap(),
        "external contents"
    );
    worker.finish();
}

#[test]
fn rapid_slider_ticks_keep_latest_preview_and_preserve_save_order() {
    let root = tempfile::tempdir().unwrap();
    let path = root.path().join("grey.dng");
    let bytes = include_bytes!("../../apple/MapleUITests/Fixtures/synthetic/grey-l018-rggb.dng");
    std::fs::write(&path, bytes).unwrap();
    let mut worker = Worker::new(eframe::egui::Context::default());
    worker.send(Command::Open(
        1,
        Folder::scan(root.path()).unwrap().photos.remove(0),
    ));
    let mut document = match receive(&worker) {
        Event::Opened(1, Ok((document, _))) => *document,
        _ => panic!("open failed"),
    };
    let mut previews = 0;
    for generation in 1..=2000 {
        Control::Exposure
            .set(&mut document.model, generation as f32 / 2000.0)
            .unwrap();
        worker.send(Command::Render(1, generation, document.model.clone()));
    }
    worker.send(Command::Save(1, document));
    let mut latest = None;
    loop {
        match receive(&worker) {
            Event::Rendered(1, generation, Ok(image)) => {
                previews += 1;
                latest = Some((generation, image));
            }
            Event::Saved(1, Ok(())) => break,
            _ => panic!("slider/save worker failed"),
        }
    }
    assert!(previews < 2000, "obsolete render backlog was not skipped");
    let (generation, before) = latest.expect("latest preview");
    assert_eq!(generation, 2000);
    worker.send(Command::Open(
        2,
        Folder::scan(root.path()).unwrap().photos.remove(0),
    ));
    let reopened = match receive(&worker) {
        Event::Opened(2, Ok((document, _))) => *document,
        _ => panic!("reopen failed"),
    };
    assert_eq!(reopened.model.exposure, 1.0);
    worker.send(Command::Render(2, 1, reopened.model));
    let after = match receive(&worker) {
        Event::Rendered(2, 1, Ok(image)) => image,
        _ => panic!("reopened render failed"),
    };
    assert_eq!(before.pixels, after.pixels);
    assert_eq!(std::fs::read(path).unwrap(), bytes);
    worker.finish();
}

#[test]
fn comparison_renders_an_independent_model_without_saving_or_rebinding_the_session() {
    let root = tempfile::tempdir().unwrap();
    let path = root.path().join("grey.dng");
    let bytes = include_bytes!("../../apple/MapleUITests/Fixtures/synthetic/grey-l018-rggb.dng");
    std::fs::write(&path, bytes).unwrap();
    let mut worker = Worker::new(eframe::egui::Context::default());
    worker.send(Command::Open(
        1,
        Folder::scan(root.path()).unwrap().photos.remove(0),
    ));
    let mut document = match receive(&worker) {
        Event::Opened(1, Ok((document, _))) => *document,
        _ => panic!("open failed"),
    };
    document.model.profile = raw_core::types::adjustment::Profile::Neutral;
    let before_model = document.model.clone();
    Control::Exposure.set(&mut document.model, 1.0).unwrap();
    worker.send(Command::Render(1, 1, document.model.clone()));
    let after = match receive(&worker) {
        Event::Rendered(1, 1, Ok(image)) => image,
        _ => panic!("edited render failed"),
    };
    worker.send(Command::Comparison(1, before_model.clone()));
    let before = match receive(&worker) {
        Event::Comparison(1, model, Ok(image)) => {
            assert_eq!(*model, before_model);
            image
        }
        _ => panic!("comparison render failed"),
    };
    assert_eq!(before.size, after.size);
    assert_ne!(before.pixels, after.pixels);
    worker.send(Command::Render(1, 2, document.model));
    let retained = match receive(&worker) {
        Event::Rendered(1, 2, Ok(image)) => image,
        _ => panic!("live session no longer renders"),
    };
    assert_eq!(retained.pixels, after.pixels);
    assert!(!path.with_extension("xmp").exists());
    assert_eq!(std::fs::read(path).unwrap(), bytes);
    worker.finish();
}

#[test]
fn raster_worker_edits_saves_reopens_and_exports_without_modifying_source() {
    let sources = [
        (
            "png",
            raw_core::png::encode(8, 6, &[80; 8 * 6 * 3]).unwrap(),
        ),
        ("webp", include_bytes!("fixtures/opaque-grey.webp").to_vec()),
    ];
    for (extension, source) in sources {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join(format!("photo.{extension}"));
        std::fs::write(&path, &source).unwrap();
        let photo = Folder::scan(root.path()).unwrap().photos.remove(0);
        let mut worker = Worker::new(eframe::egui::Context::default());
        worker.send(Command::Open(1, photo.clone()));
        let mut document = match receive(&worker) {
            Event::Opened(1, Ok((document, _))) => *document,
            _ => panic!("Raster open failed"),
        };
        worker.send(Command::Render(1, 1, document.model.clone()));
        let before = match receive(&worker) {
            Event::Rendered(1, 1, Ok(image)) => image,
            _ => panic!("Raster preview failed"),
        };
        Control::Exposure.set(&mut document.model, 1.0).unwrap();
        worker.send(Command::Render(1, 2, document.model.clone()));
        let edited = match receive(&worker) {
            Event::Rendered(1, 2, Ok(image)) => image,
            _ => panic!("Raster exposure render failed"),
        };
        assert_ne!(edited.pixels, before.pixels);
        let output = root.path().join("edited.png");
        worker.send(Command::Export(
            photo.clone(),
            document.model.clone(),
            output.clone(),
        ));
        assert!(matches!(receive(&worker), Event::Exported(_, Ok(()))));
        let decoded =
            raw_core::raster::decode_raster(&std::fs::read(output).unwrap(), Some("png")).unwrap();
        assert_eq!((decoded.width, decoded.height), (8, 6));
        assert!(decoded.data.iter().all(|v| *v > 80));
        worker.send(Command::Save(1, document));
        assert!(matches!(receive(&worker), Event::Saved(1, Ok(()))));
        worker.send(Command::Open(2, photo));
        let document = match receive(&worker) {
            Event::Opened(2, Ok((document, _))) => *document,
            _ => panic!("Raster reopen failed"),
        };
        assert_eq!(document.model.exposure, 1.0);
        worker.send(Command::Render(2, 1, document.model));
        let reopened = match receive(&worker) {
            Event::Rendered(2, 1, Ok(image)) => image,
            _ => panic!("Raster saved edit render failed"),
        };
        assert_eq!(edited.pixels, reopened.pixels);
        assert_eq!(std::fs::read(path).unwrap(), source);
        worker.finish();
    }
}

#[test]
fn imported_film_preview_and_export_match_shared_core_without_touching_raw() {
    let root = tempfile::tempdir().unwrap();
    let source =
        Path::new(env!("CARGO_MANIFEST_DIR")).join("../../test-fixtures/batch-transfer/source.dng");
    let bytes = std::fs::read(source).unwrap();
    let path = root.path().join("film.dng");
    std::fs::write(&path, &bytes).unwrap();
    let photo = Folder::scan(root.path()).unwrap().photos.remove(0);
    let mut worker = Worker::new(eframe::egui::Context::default());
    worker.send(Command::Open(1, photo.clone()));
    let document = match receive(&worker) {
        Event::Opened(1, Ok((document, _))) => *document,
        _ => panic!("RAW open failed"),
    };
    worker.send(Command::Render(1, 1, document.model.clone()));
    let baseline = match receive(&worker) {
        Event::Rendered(1, 1, Ok(image)) => image,
        _ => panic!("baseline preview failed"),
    };
    let id = raw_core::film_catalog::FILM_CATALOG[0].id;
    let xmp = format!(
        r#"<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><rdf:Description xmlns:papp="http://ns.justmaple.app/photo/1.0/" papp:FilmLook="{id}" papp:FilmStrength="100"/></rdf:RDF></x:xmpmeta>"#
    );
    std::fs::write(path.with_extension("xmp"), xmp).unwrap();
    worker.send(Command::Open(2, photo.clone()));
    let document = match receive(&worker) {
        Event::Opened(2, Ok((document, _))) => *document,
        _ => panic!("imported film sidecar open failed"),
    };
    let model = document.model.clone();
    assert_eq!(model.film_look, id);
    assert_eq!(model.film_strength, 100.0);
    worker.send(Command::Render(2, 2, model.clone()));
    let actual = match receive(&worker) {
        Event::Rendered(2, 2, Ok(image)) => image,
        _ => panic!("film preview failed"),
    };
    let raw = raw_core::decode::decode(&path).unwrap();
    let film = maple_linux::film::resolve(&model.film_look)
        .unwrap()
        .unwrap();
    let (w, h, expected) = raw_core::pipeline::render_sized_from_raw_with_quality_source_and_film(
        &raw,
        &model,
        raw_core::pipeline::RenderQuality::Preview,
        Some(raw_core::pipeline::RawInput::Path(&path)),
        1600,
        Some(film.lut),
    )
    .unwrap();
    assert_eq!(
        actual,
        eframe::egui::ColorImage::from_rgb([w as usize, h as usize], &expected)
    );
    assert_ne!(
        actual.pixels, baseline.pixels,
        "real film look must change the render"
    );
    worker.send(Command::Comparison(2, model.clone()));
    match receive(&worker) {
        Event::Comparison(2, returned, Ok(image)) => {
            assert_eq!(*returned, model);
            assert_eq!(image, actual);
        }
        _ => panic!("film comparison failed"),
    }
    let destination = root.path().join("film.png");
    worker.send(Command::Export(photo, model.clone(), destination.clone()));
    assert!(matches!(receive(&worker), Event::Exported(_, Ok(()))));
    let expected = raw_core::export::export_from_raw_with_film(
        &raw,
        &model,
        Some(raw_core::pipeline::RawInput::Path(&path)),
        &raw_core::export::ExportOptions {
            format: raw_core::export::ExportFormat::Png,
            quality: 95,
            target: raw_core::view::encode::TargetPrimaries::Srgb,
            max_long_edge: None,
        },
        Some(film.lut),
    )
    .unwrap();
    assert_eq!(std::fs::read(destination).unwrap(), expected.bytes);
    let mut edited = document;
    Control::Exposure.set(&mut edited.model, 1.0).unwrap();
    worker.send(Command::Save(2, edited));
    assert!(matches!(receive(&worker), Event::Saved(2, Ok(()))));
    let saved = raw_core::xmp::parse(&std::fs::read_to_string(path.with_extension("xmp")).unwrap())
        .unwrap();
    assert_eq!(saved.exposure, 1.0);
    assert_eq!(saved.film_look, id);
    assert_eq!(saved.film_strength, 100.0);
    assert_eq!(std::fs::read(path).unwrap(), bytes);
    worker.finish();
}
