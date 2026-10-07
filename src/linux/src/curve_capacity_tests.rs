use super::*;
use std::time::Duration;

fn receive(worker: &Worker) -> Event {
    worker.events.recv_timeout(Duration::from_secs(30)).unwrap()
}

#[test]
fn oversized_imported_curves_fall_back_save_exact_points_and_keep_worker_live() {
    for display in [false, true] {
        let root = tempfile::tempdir().unwrap();
        let bytes = std::fs::read(
            PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                .join("../../test-fixtures/batch-transfer/source.dng"),
        )
        .unwrap();
        let path = root.path().join("photo.dng");
        std::fs::write(&path, &bytes).unwrap();
        let element = if display {
            "crs:ToneCurvePV2012Red"
        } else {
            "papp:SceneLinearToneCurve"
        };
        let leaves: String = (0..40)
            .map(|i| {
                let x = i as f32 / 39.0;
                format!("<rdf:li>{}, {}</rdf:li>", x * 255.0, x.powf(0.8) * 255.0)
            })
            .collect();
        let curve = format!("<{element}><rdf:Seq>{leaves}</rdf:Seq></{element}>");
        let xml = format!(
            "<x:xmpmeta xmlns:x='adobe:ns:meta/'><rdf:RDF xmlns:rdf='http://www.w3.org/1999/02/22-rdf-syntax-ns#'><rdf:Description xmlns:crs='http://ns.adobe.com/camera-raw-settings/1.0/' xmlns:papp='http://ns.justmaple.app/photo/1.0/'>{curve}</rdf:Description></rdf:RDF></x:xmpmeta>"
        );
        std::fs::write(path.with_extension("xmp"), xml).unwrap();
        let photo = Folder::scan(root.path()).unwrap().photos.remove(0);
        let (reference, document) = Session::open(1, photo.clone()).unwrap();
        let points = if display {
            document.model.display_tone_curve_red.points.clone()
        } else {
            document.model.tone_curve_luma.points.clone()
        };
        assert_eq!(points.len(), 40);
        let expected = reference.render(&document.model, 1600).unwrap();
        let mut worker = Worker::with_gpu(
            egui::Context::default(),
            Some(raw_gpu::GpuContext::new_blocking().unwrap()),
        );
        worker.send(Command::Open(1, photo));
        assert!(matches!(receive(&worker), Event::Opened(1, Ok(_))));
        worker.send(Command::Render(1, 1, document.model.clone()));
        assert!(matches!(receive(&worker), Event::GpuFallback(1, 1, error)
            if error.contains("control-point capacity")));
        match receive(&worker) {
            Event::Rendered(1, 1, Ok(frame)) => assert_eq!(frame.pixels, expected.pixels),
            _ => panic!("CPU fallback must publish a real preview"),
        }
        worker.send(Command::Save(1, document));
        assert!(matches!(receive(&worker), Event::Saved(1, Ok(()))));
        let (_, saved) = SidecarStore::open(&path).unwrap();
        let saved_points = if display {
            &saved.model.display_tone_curve_red.points
        } else {
            &saved.model.tone_curve_luma.points
        };
        assert_eq!(saved_points, &points);
        assert!(std::fs::read_to_string(path.with_extension("xmp"))
            .unwrap()
            .contains(&curve));
        assert_eq!(std::fs::read(&path).unwrap(), bytes);
        worker.finish();
    }
}
