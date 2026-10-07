//! Linux retained detail binding and worker protocol on a committed real RAW.
use maple_linux::{
    detail::DetailRenderer,
    jobs::{Command, Event, Worker},
    library::Folder,
};
use raw_core::{
    pipeline::{self, DetailRenderOptions, RawInput, RenderQuality, TileRect},
    types::adjustment::AdjustmentModel,
};
use std::{path::PathBuf, time::Duration};

fn source() -> (PathBuf, Vec<u8>, raw_core::RawImage) {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../test-fixtures/batch-transfer/source.dng");
    let bytes = std::fs::read(&path).unwrap();
    let raw = raw_core::decode::decode(&path).unwrap();
    (path, bytes, raw)
}
fn rect(raw: &raw_core::RawImage, offset: u32) -> TileRect {
    let (w, h) = pipeline::native_render_dims(raw);
    TileRect {
        src_x: offset,
        src_y: offset,
        src_w: w / 2,
        src_h: h / 2,
        out_w: w / 2,
        out_h: h / 2,
    }
}
#[test]
fn retained_native_patches_match_core_and_refresh_after_edit_or_rejection() {
    let (path, bytes, raw) = source();
    let mut model = AdjustmentModel {
        exposure: 0.4,
        ..Default::default()
    };
    model.film_look = raw_core::film_catalog::FILM_CATALOG[0].id.into();
    model.film_strength = 55.0;
    let film = maple_linux::film::resolve(&model.film_look)
        .unwrap()
        .unwrap();
    let (w, h, base, context) = pipeline::render_detail_base(
        &raw,
        &model,
        RawInput::Bytes {
            bytes: &bytes,
            ext: "dng",
        },
        DetailRenderOptions {
            quality: RenderQuality::Preview,
            max_long_edge: 1600,
            film_lut: Some(film.lut),
        },
    )
    .unwrap();
    let mut renderer = DetailRenderer::default();
    let mut previous_base = None;
    for offset in [0, 8] {
        let rect = rect(&raw, offset);
        let frame = renderer.render(&raw, &bytes, "dng", &model, rect).unwrap();
        assert_eq!(frame.native_size, pipeline::native_render_dims(&raw));
        if offset == 0 {
            assert_eq!(
                *frame.base,
                eframe::egui::ColorImage::from_rgb([w as usize, h as usize], &base)
            );
        } else {
            assert!(
                std::sync::Arc::ptr_eq(previous_base.as_ref().unwrap(), &frame.base),
                "pan must reuse full-frame anchors and base pixels"
            );
        }
        previous_base = Some(frame.base.clone());
        let (pw, ph, expected) =
            pipeline::render_detail_tile(&raw, &context, rect, Some(film.lut), 8_388_608).unwrap();
        assert_eq!(
            frame.patch,
            eframe::egui::ColorImage::from_rgb([pw as usize, ph as usize], &expected)
        );
    }
    model.exposure = 1.0;
    let edited = renderer
        .render(&raw, &bytes, "dng", &model, rect(&raw, 0))
        .unwrap();
    assert!(
        !std::sync::Arc::ptr_eq(previous_base.as_ref().unwrap(), &edited.base),
        "edit must refresh the reference anchors"
    );
    let invalid = TileRect {
        src_x: u32::MAX,
        ..rect(&raw, 0)
    };
    assert!(renderer
        .render(&raw, &bytes, "dng", &model, invalid)
        .is_err());
    assert!(
        renderer
            .render(&raw, &bytes, "dng", &model, rect(&raw, 0))
            .unwrap()
            .base
            .size[0]
            > 0,
        "retry must publish its base after a rejected patch"
    );
    model.crop.right = 0.5;
    for angle in [0.0, 3.5] {
        model.crop.angle = angle;
        let frame = renderer
            .render(&raw, &bytes, "dng", &model, rect(&raw, 0))
            .unwrap();
        let (_, _, _, context) = pipeline::render_detail_base(
            &raw,
            &model,
            RawInput::Bytes {
                bytes: &bytes,
                ext: "dng",
            },
            DetailRenderOptions {
                quality: RenderQuality::Preview,
                max_long_edge: 1600,
                film_lut: Some(film.lut),
            },
        )
        .unwrap();
        let (pw, ph, expected) =
            pipeline::render_detail_tile(&raw, &context, rect(&raw, 0), Some(film.lut), 8_388_608)
                .unwrap();
        assert_eq!(
            frame.patch,
            eframe::egui::ColorImage::from_rgb([pw as usize, ph as usize], &expected,)
        );
    }
    model.perspective_vertical = 10.0;
    assert!(renderer
        .render(&raw, &bytes, "dng", &model, rect(&raw, 0))
        .is_err());
    assert_eq!(std::fs::read(path).unwrap(), bytes);
}

#[test]
fn worker_retains_decode_for_pans_and_rejects_closed_detail_session() {
    let (source, bytes, raw) = source();
    let root = tempfile::tempdir().unwrap();
    let path = root.path().join("source.dng");
    std::fs::copy(source, &path).unwrap();
    let mut worker = Worker::new(eframe::egui::Context::default());
    worker.send(Command::Open(
        71,
        Folder::scan(root.path()).unwrap().photos.remove(0),
    ));
    let document = match worker.events.recv_timeout(Duration::from_secs(30)).unwrap() {
        Event::Opened(71, Ok((document, _))) => document,
        _ => panic!("open"),
    };
    let mut previous_base = None;
    for generation in [1, 2] {
        worker.send(Command::Detail(
            71,
            generation,
            document.model.clone(),
            rect(&raw, if generation == 1 { 0 } else { 8 }),
        ));
        match worker.events.recv_timeout(Duration::from_secs(30)).unwrap() {
            Event::Detail(71, g, Ok(frame)) => {
                assert_eq!(g, generation);
                if let Some(previous) = &previous_base {
                    assert!(std::sync::Arc::ptr_eq(previous, &frame.base));
                }
                previous_base = Some(frame.base.clone());
                assert!(!frame.patch.pixels.is_empty());
            }
            _ => panic!("detail"),
        }
    }
    worker.send(Command::Detail(
        70,
        3,
        document.model.clone(),
        rect(&raw, 0),
    ));
    assert!(matches!(
        worker.events.recv_timeout(Duration::from_secs(30)).unwrap(),
        Event::Detail(70, 3, Err(_))
    ));
    assert_eq!(std::fs::read(path).unwrap(), bytes);
    worker.finish();
}

#[test]
fn worker_detail_uses_the_open_source_snapshot_after_external_file_change() {
    let (source, bytes, raw) = source();
    let root = tempfile::tempdir().unwrap();
    let path = root.path().join("source.dng");
    std::fs::copy(source, &path).unwrap();
    let mut worker = Worker::new(eframe::egui::Context::default());
    worker.send(Command::Open(
        81,
        Folder::scan(root.path()).unwrap().photos.remove(0),
    ));
    let model = match worker.events.recv_timeout(Duration::from_secs(30)).unwrap() {
        Event::Opened(81, Ok((document, _))) => document.model,
        _ => panic!("open"),
    };
    // Simulate another application changing this temporary input after open.
    let external = b"externally replaced temporary test input";
    std::fs::write(&path, external).unwrap();
    worker.send(Command::Detail(81, 1, model.clone(), rect(&raw, 0)));
    let frame = match worker.events.recv_timeout(Duration::from_secs(30)).unwrap() {
        Event::Detail(81, 1, Ok(frame)) => frame,
        _ => panic!("retained source detail"),
    };
    let expected = DetailRenderer::default()
        .render(&raw, &bytes, "dng", &model, rect(&raw, 0))
        .unwrap();
    assert_eq!(frame.patch, expected.patch);
    assert_eq!(*frame.base, *expected.base);
    assert_eq!(
        std::fs::read(path).unwrap(),
        external,
        "worker must not overwrite an external replacement"
    );
    worker.finish();
}
