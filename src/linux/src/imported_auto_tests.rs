use crate::{
    jobs::{Command, Event, Worker},
    library::Folder,
};
use eframe::egui;
use raw_core::stages::imported_auto_wb;
use std::{
    path::PathBuf,
    sync::{mpsc, Arc},
    time::Duration,
};

fn source() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../test-fixtures/batch-transfer/source.dng")
}

#[test]
fn first_frame_is_as_shot_and_one_estimate_follows_it_without_rewriting_the_sidecar() {
    let root = tempfile::tempdir().unwrap();
    let raw_path = root.path().join("photo.dng");
    std::fs::copy(source(), &raw_path).unwrap();
    let xml = r#"<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><rdf:Description xmlns:crs="http://ns.adobe.com/camera-raw-settings/1.0/" crs:WhiteBalance="Auto"/></rdf:RDF></x:xmpmeta>"#;
    let sidecar = root.path().join("photo.xmp");
    std::fs::write(&sidecar, xml).unwrap();
    let original = std::fs::read(&raw_path).unwrap();
    let photo = Folder::scan(root.path()).unwrap().photos.remove(0);
    let mut worker = Worker::new(egui::Context::default());
    let receive = |worker: &Worker| {
        worker
            .events
            .recv_timeout(Duration::from_secs(120))
            .unwrap()
    };
    worker.send(Command::Open(7, photo));
    let document = match receive(&worker) {
        Event::Opened(_, Ok((document, _))) => *document,
        _ => panic!("open"),
    };
    assert!(imported_auto_wb::needs_resolution(&document.model));
    worker.send(Command::Render(7, 1, document.model.clone()));
    let raw = raw_core::decode::decode(&source()).unwrap();
    let expected = imported_auto_wb::estimate(&raw, raw_core::CancelToken::never()).unwrap();
    let (mut first, mut pair) = (None, None);
    while first.is_none() || pair.is_none() {
        match receive(&worker) {
            Event::Rendered(7, 1, result, _) => first = Some(result.unwrap()),
            // The estimate starts only once the first frame was sent (#4669).
            Event::ImportedWhiteBalance(7, resolved) => {
                assert!(first.is_some(), "estimated before the first frame");
                pair = Some(resolved)
            }
            _ => {}
        }
    }
    assert_eq!(pair, Some(expected));
    let first = first.unwrap();
    let render = |generation, model| {
        worker.send(Command::Render(7, generation, model));
        loop {
            match receive(&worker) {
                Event::Rendered(7, rendered, result, _) if rendered == generation => {
                    break result.unwrap()
                }
                Event::ImportedWhiteBalance(..) => panic!("estimated twice"),
                _ => {}
            }
        }
    };
    // The first frame is the As Shot render, never the core's synchronous resolve.
    let mut as_shot = document.model.clone();
    as_shot.unresolved_auto_wb = false;
    assert!(render(2, as_shot) == first);
    let mut resolved = document.model.clone();
    imported_auto_wb::apply_pair(&mut resolved, expected);
    assert!(render(3, resolved) != first);
    // A later render of the same session starts no second estimate.
    assert!(render(4, document.model.clone()) == first);
    assert!(worker
        .events
        .recv_timeout(Duration::from_millis(500))
        .is_err());
    assert_eq!(std::fs::read_to_string(&sidecar).unwrap(), xml);
    assert_eq!(std::fs::read(&raw_path).unwrap(), original);
    worker.finish();
}

#[test]
fn dropping_a_sessions_estimate_cancels_it_and_releases_the_raw() {
    let raw = Arc::new(raw_core::decode::decode(&source()).unwrap());
    let (results, events) = mpsc::channel();
    let estimate = super::spawn_estimate(7, Arc::clone(&raw), results, egui::Context::default());
    // Navigation or close drops the session, and its estimate with it.
    drop(estimate);
    // The thread ends without publishing a pair: its sender disconnects.
    assert!(matches!(
        events.recv_timeout(Duration::from_secs(120)),
        Err(mpsc::RecvTimeoutError::Disconnected)
    ));
    assert_eq!(Arc::strong_count(&raw), 1);
}
