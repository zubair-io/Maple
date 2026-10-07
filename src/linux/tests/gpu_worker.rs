//! Production worker handoff on actual RAW files and shared GPU resources.
use maple_linux::{
    jobs::{Command, Event, Worker},
    library::Folder,
};
use std::time::Duration;

#[test]
fn native_worker_publishes_resident_frames_and_saves_without_touching_raw() {
    let root = tempfile::tempdir().unwrap();
    let source = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../test-fixtures/batch-transfer/source.dng");
    let bytes = std::fs::read(source).unwrap();
    let path = root.path().join("source.dng");
    std::fs::write(&path, &bytes).unwrap();
    // Imported geometry is retained verbatim: the current inspector owns
    // scalar develop controls, not crop authoring.
    std::fs::write(root.path().join("source.xmp"), r#"<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><rdf:Description xmlns:crs="http://ns.adobe.com/camera-raw-settings/1.0/" crs:HasCrop="True" crs:CropLeft="0.25" crs:CropRight="0.75" crs:CropTop="0" crs:CropBottom="1" crs:CropAngle="0"/></rdf:RDF></x:xmpmeta>"#).unwrap();
    let photo = Folder::scan(root.path()).unwrap().photos.remove(0);
    let gpu = raw_gpu::GpuContext::new_blocking().unwrap();
    let device = gpu.device.clone();
    let mut worker = Worker::with_gpu(eframe::egui::Context::default(), Some(gpu));
    worker.send(Command::Open(1, photo));
    let receive = |worker: &Worker| {
        worker
            .events
            .recv_timeout(Duration::from_secs(120))
            .unwrap()
    };
    let mut document = match receive(&worker) {
        Event::Opened(1, Ok((doc, _))) => *doc,
        _ => panic!("RAW open failed"),
    };
    worker.send(Command::Render(1, 1, document.model.clone()));
    let first = match receive(&worker) {
        Event::GpuRendered(1, 1, frame) => frame,
        Event::GpuFallback(_, _, reason) => panic!("Unexpected fallback: {reason}"),
        _ => panic!("Native RAW did not use resident GPU output"),
    };
    assert!(std::sync::Arc::ptr_eq(&first.device, &device));
    assert!(first.dims.0 > 0 && first.dims.1 > 0);
    document.model.exposure = 1.0;
    worker.send(Command::Render(1, 2, document.model.clone()));
    let second = match receive(&worker) {
        Event::GpuRendered(1, 2, frame) => frame,
        _ => panic!("Edited RAW did not use resident GPU output"),
    };
    assert!(std::sync::Arc::ptr_eq(&first.view, &second.view));
    document.model.profile = raw_core::types::adjustment::Profile::Neutral;
    worker.send(Command::Render(1, 3, document.model.clone()));
    let neutral = match receive(&worker) {
        Event::GpuRendered(1, 3, frame) => frame,
        _ => panic!("Profile change did not prepare a resident frame"),
    };
    assert!(!std::sync::Arc::ptr_eq(&second.view, &neutral.view));
    document.model.crop.left = 0.375;
    document.model.crop.right = 0.625;
    worker.send(Command::Render(1, 4, document.model.clone()));
    match receive(&worker) {
        Event::GpuRendered(1, 4, frame) => assert!(frame.dims.0 < neutral.dims.0),
        _ => panic!("A cropped frame must present cropped resident pixels"),
    }
    document.model.crop.angle = 3.5;
    document.model.perspective_vertical = 10.0;
    worker.send(Command::Render(1, 5, document.model.clone()));
    match receive(&worker) {
        Event::GpuFallback(1, 5, reason) => assert!(reason.contains("Combined perspective")),
        _ => panic!("Two geometry resampling steps must not silently collapse"),
    }
    match receive(&worker) {
        Event::Rendered(1, 5, Ok(image)) => assert!(image.size[0] > 0 && image.size[1] > 0),
        _ => panic!("Combined geometry fallback did not produce CPU pixels"),
    }
    worker.send(Command::Save(1, document));
    assert!(matches!(receive(&worker), Event::Saved(1, Ok(()))));
    worker.finish();
    assert_eq!(std::fs::read(path).unwrap(), bytes);
    let saved =
        raw_core::xmp::parse(&std::fs::read_to_string(root.path().join("source.xmp")).unwrap())
            .unwrap();
    assert_eq!(saved.exposure, 1.0);
    assert_eq!(
        (saved.crop.left, saved.crop.right, saved.crop.angle),
        (0.25, 0.75, 0.0)
    );
    assert_eq!(saved.perspective_vertical, 0.0);
}
