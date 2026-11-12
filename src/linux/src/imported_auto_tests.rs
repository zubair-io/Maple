use crate::{
    jobs::{Command, Event, Worker},
    library::Folder,
};
use eframe::egui;
use std::{path::PathBuf, time::Duration};

#[test]
fn first_frame_is_as_shot_and_one_estimate_follows_without_rewriting_the_sidecar() {
    let root = tempfile::tempdir().unwrap();
    let source = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../test-fixtures/batch-transfer/source.dng");
    let raw_path = root.path().join("photo.dng");
    std::fs::copy(&source, &raw_path).unwrap();
    let xml = r#"<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><rdf:Description xmlns:crs="http://ns.adobe.com/camera-raw-settings/1.0/" crs:WhiteBalance="Auto"/></rdf:RDF></x:xmpmeta>"#;
    let sidecar = root.path().join("photo.xmp");
    std::fs::write(&sidecar, xml).unwrap();
    let original = std::fs::read(&raw_path).unwrap();
    let photo = Folder::scan(root.path()).unwrap().photos.remove(0);
    let mut worker = Worker::new(egui::Context::default());
    let receive = |worker: &Worker| worker.events.recv_timeout(Duration::from_secs(60)).unwrap();
    worker.send(Command::Open(7, photo));
    let document = match receive(&worker) {
        Event::Opened(_, Ok((document, _))) => *document,
        _ => panic!("open"),
    };
    assert!(raw_core::stages::imported_auto_wb::needs_resolution(
        &document.model
    ));
    worker.send(Command::Render(7, 1, document.model.clone()));
    let raw = raw_core::decode::decode(&source).unwrap();
    let expected =
        raw_core::stages::imported_auto_wb::estimate(&raw, raw_core::CancelToken::never()).unwrap();
    let (mut rendered, mut pair) = (false, None);
    while !rendered || pair.is_none() {
        match receive(&worker) {
            Event::Rendered(7, 1, result, _) => rendered = result.is_ok(),
            Event::ImportedWhiteBalance(7, resolved) => pair = Some(resolved),
            _ => {}
        }
    }
    assert_eq!(pair, Some(expected));
    // A second render of the same session starts no second estimate.
    worker.send(Command::Render(7, 2, document.model.clone()));
    loop {
        match receive(&worker) {
            Event::Rendered(7, 2, _, _) => break,
            Event::ImportedWhiteBalance(..) => panic!("estimated twice"),
            _ => {}
        }
    }
    assert!(worker
        .events
        .recv_timeout(Duration::from_millis(500))
        .is_err());
    assert_eq!(std::fs::read_to_string(&sidecar).unwrap(), xml);
    assert_eq!(std::fs::read(&raw_path).unwrap(), original);
    worker.finish();
}
