//! Deterministic scheduling checks; the gate pauses only detail execution.
//! All GPU frames and sidecars still use the real production implementations.
use super::*;
use std::time::Duration;

fn receive(worker: &Worker) -> Event {
    worker
        .events
        .recv_timeout(Duration::from_secs(30))
        .expect("worker completion")
}
fn fixture() -> (tempfile::TempDir, Photo) {
    let root = tempfile::tempdir().unwrap();
    let source = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../test-fixtures/batch-transfer/source.dng");
    std::fs::copy(source, root.path().join("photo.dng")).unwrap();
    let photo = Folder::scan(root.path()).unwrap().photos.remove(0);
    (root, photo)
}
fn open(worker: &Worker, id: u64, photo: Photo) -> SidecarDocument {
    worker.send(Command::Open(id, photo));
    match receive(worker) {
        Event::Opened(_, Ok((document, _))) => *document,
        _ => panic!("open"),
    }
}
fn patch() -> pipeline::TileRect {
    pipeline::TileRect {
        src_x: 0,
        src_y: 0,
        src_w: 32,
        src_h: 24,
        out_w: 32,
        out_h: 24,
    }
}

#[test]
fn leaving_native_zoom_cancels_paused_detail_and_allows_resumption() {
    let (_root, photo) = fixture();
    let original = std::fs::read(&photo.path).unwrap();
    let mut worker = Worker::new(egui::Context::default());
    let document = open(&worker, 81, photo.clone());
    let source = worker.detail.source.lock().unwrap().clone().unwrap();
    let pause = worker.detail.pause_next();
    worker.send(Command::Detail(81, 1, document.model.clone(), patch()));
    pause.began.recv_timeout(Duration::from_secs(30)).unwrap();
    worker.cancel_detail();
    assert!(Arc::ptr_eq(
        &source,
        worker.detail.source.lock().unwrap().as_ref().unwrap()
    ));
    pause.resume();
    worker.send(Command::Detail(81, 2, document.model, patch()));
    assert!(matches!(receive(&worker), Event::Detail(81, 2, Ok(_))));
    assert_eq!(std::fs::read(photo.path).unwrap(), original);
    worker.finish();
}

#[test]
fn paused_detail_does_not_block_real_gpu_preview_or_xmp_save() {
    let (_root, photo) = fixture();
    let original = std::fs::read(&photo.path).unwrap();
    let mut worker = Worker::with_gpu(
        egui::Context::default(),
        Some(raw_gpu::GpuContext::new_blocking().unwrap()),
    );
    let mut document = open(&worker, 91, photo.clone());
    // Exactly one mosaic/byte allocation is shared by the GPU and detail owners.
    let source = worker.detail.source.lock().unwrap().clone().unwrap();
    assert_eq!(Arc::strong_count(source.raw.as_ref().unwrap()), 2);
    assert_eq!(Arc::strong_count(&source.bytes), 2);
    let pause = worker.detail.pause_next();
    worker.send(Command::Detail(91, 1, document.model.clone(), patch()));
    pause.began.recv_timeout(Duration::from_secs(30)).unwrap();
    document.model.exposure = 1.0;
    worker.send(Command::Render(91, 2, document.model.clone()));
    worker.send(Command::Save(91, document.clone()));
    assert!(
        matches!(receive(&worker), Event::GpuRendered(91, 2, _)),
        "GPU must complete while detail is still paused"
    );
    assert!(
        matches!(receive(&worker), Event::Saved(91, Ok(()))),
        "save must complete while detail is still paused"
    );
    let stored = SidecarStore::open(&photo.path).unwrap().1;
    assert_eq!(stored.model.exposure, 1.0);
    pause.resume();
    worker.send(Command::Detail(91, 3, document.model.clone(), patch()));
    assert!(
        matches!(receive(&worker), Event::Detail(91, 3, Ok(_))),
        "superseded paused detail cannot publish"
    );
    assert_eq!(std::fs::read(photo.path).unwrap(), original);
    worker.finish();
}

#[test]
fn detail_burst_keeps_only_latest_snapshot_and_reopened_id_uses_new_reference() {
    let (_root, photo) = fixture();
    let mut worker = Worker::new(egui::Context::default());
    let document = open(&worker, 101, photo.clone());
    let pause = worker.detail.pause_next();
    worker.send(Command::Detail(101, 1, document.model.clone(), patch()));
    pause.began.recv_timeout(Duration::from_secs(30)).unwrap();
    for generation in 2..=1000 {
        worker.send(Command::Detail(
            101,
            generation,
            document.model.clone(),
            patch(),
        ));
    }
    pause.resume();
    let first = match receive(&worker) {
        Event::Detail(101, 1000, Ok(frame)) => frame,
        _ => panic!("latest detail only"),
    };
    // The caller can reuse a numeric ID; source identity still refreshes anchors.
    open(&worker, 101, photo);
    worker.send(Command::Detail(101, 1001, document.model, patch()));
    let second = match receive(&worker) {
        Event::Detail(101, 1001, Ok(frame)) => frame,
        _ => panic!("reopened detail"),
    };
    assert!(!Arc::ptr_eq(&first.base, &second.base));
    assert_eq!(*first.base, *second.base);
    assert_eq!(first.patch, second.patch);
    worker.finish();
}

#[test]
fn source_switch_during_paused_detail_keeps_gpu_live_and_releases_old_snapshot() {
    let (_root, photo) = fixture();
    let mut worker = Worker::with_gpu(
        egui::Context::default(),
        Some(raw_gpu::GpuContext::new_blocking().unwrap()),
    );
    let first = open(&worker, 111, photo.clone());
    let old_source = Arc::downgrade(worker.detail.source.lock().unwrap().as_ref().unwrap());
    let old_raw = Arc::downgrade(old_source.upgrade().unwrap().raw.as_ref().unwrap());
    let pause = worker.detail.pause_next();
    worker.send(Command::Detail(111, 1, first.model, patch()));
    pause.began.recv_timeout(Duration::from_secs(30)).unwrap();
    let second = open(&worker, 112, photo);
    assert_eq!(
        old_raw.strong_count(),
        1,
        "only in-flight detail may retain the old mosaic"
    );
    worker.send(Command::Render(112, 2, second.model.clone()));
    assert!(
        matches!(receive(&worker), Event::GpuRendered(112, 2, _)),
        "new-source preview must not wait for old-source detail"
    );
    worker.send(Command::Detail(112, 3, second.model, patch()));
    pause.resume();
    assert!(
        matches!(receive(&worker), Event::Detail(112, 3, Ok(_))),
        "old-source detail cannot publish on the new image"
    );
    assert!(old_source.upgrade().is_none());
    assert!(old_raw.upgrade().is_none());
    let new_source = Arc::downgrade(worker.detail.source.lock().unwrap().as_ref().unwrap());
    worker.finish();
    assert!(
        new_source.upgrade().is_none(),
        "joined shutdown releases source ownership"
    );
}

#[test]
fn raster_detail_uses_opened_snapshot_and_reopening_replaces_native_pixels() {
    let root = tempfile::tempdir().unwrap();
    let original = raw_core::png::encode(80, 60, &[90; 80 * 60 * 3]).unwrap();
    let replacement = raw_core::png::encode(40, 30, &[170; 40 * 30 * 3]).unwrap();
    let path = root.path().join("photo.png");
    std::fs::write(&path, &original).unwrap();
    let photo = Folder::scan(root.path()).unwrap().photos.remove(0);
    let mut worker = Worker::new(egui::Context::default());
    let document = open(&worker, 71, photo.clone());
    std::fs::write(&path, &replacement).unwrap();
    worker.send(Command::Detail(71, 1, document.model.clone(), patch()));
    let first = match receive(&worker) {
        Event::Detail(71, 1, Ok(frame)) => frame,
        _ => panic!("raster detail must publish"),
    };
    assert_eq!(first.native_size, (80, 60));
    let document = open(&worker, 71, photo);
    worker.send(Command::Detail(71, 2, document.model, patch()));
    let second = match receive(&worker) {
        Event::Detail(71, 2, Ok(frame)) => frame,
        _ => panic!("reopened raster detail must publish"),
    };
    assert_eq!(second.native_size, (40, 30));
    assert_ne!(first.patch.pixels, second.patch.pixels);
    assert!(!Arc::ptr_eq(&first.base, &second.base));
    assert_eq!(std::fs::read(&path).unwrap(), replacement);
    assert!(!path.with_extension("xmp").exists());
    worker.finish();
}

#[test]
fn rejected_native_ca_request_falls_back_without_writing_original_or_sidecar() {
    let (_root, photo) = fixture();
    let original = std::fs::read(&photo.path).unwrap();
    let mut worker = Worker::new(egui::Context::default());
    let mut document = open(&worker, 121, photo.clone());
    document.model.auto_lateral_ca = raw_core::types::adjustment::AutoLateralCa::On;
    let request = pipeline::TileRect {
        src_x: 16,
        src_y: 12,
        ..patch()
    };
    worker.send(Command::Detail(121, 1, document.model.clone(), request));
    let frame = match receive(&worker) {
        Event::Detail(121, 1, Ok(frame)) => frame,
        _ => panic!("real whole-image fallback"),
    };
    assert!(frame.whole_fallback);
    assert_eq!((frame.request.src_x, frame.request.src_y), (16, 12));
    assert_eq!((frame.rect.src_x, frame.rect.src_y), (0, 0));
    let source = worker.detail.source.lock().unwrap().clone().unwrap();
    let expected = crate::whole_detail::render(
        &source,
        &document.model,
        frame.rect,
        raw_core::CancelToken::never(),
        || false,
    )
    .unwrap()
    .unwrap();
    assert_eq!(frame.patch, expected.patch);
    assert_eq!(
        frame.patch.size,
        [frame.native_size.0 as usize, frame.native_size.1 as usize]
    );
    worker.finish();
    assert_eq!(std::fs::read(&photo.path).unwrap(), original);
    assert!(!photo.path.with_extension("xmp").exists());
}
