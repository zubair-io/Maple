use super::*;
use raw_core::test_support::synth_chart::{ChartEncoding, SyntheticColorChart};

#[test]
fn interactive_color_controls_reuse_the_prefix_and_match_single_cpu_application() {
    let source = SyntheticColorChart {
        patch_size: 8,
        guard: 2,
        encoding: ChartEncoding::Camera,
        ..Default::default()
    }
    .write_to_bytes();
    let path = std::env::temp_dir().join(format!("android-interactive-{}.dng", std::process::id()));
    std::fs::write(&path, &source).unwrap();
    let xml = "<rdf:Description xmlns:rdf=\"http://www.w3.org/1999/02/22-rdf-syntax-ns#\" xmlns:papp=\"http://ns.justmaple.app/photo/1.0/\" papp:Profile=\"Neutral\"/>";
    let mut session = Session::open(path.to_str().unwrap(), xml, 2048).unwrap();
    session.model.perspective_rotate = 2.;
    assert!(
        session.preparation().is_none(),
        "present geometry must not prepare RAW pixels"
    );
    assert!(session.geometry().is_active());
    session.model.perspective_rotate = 0.;
    let prefix = session.prefix.clone();
    let mut baseline = Vec::new();
    for (hue, saturation, defringe, bw) in [
        (0., 0., 0., false),
        (25., -20., 0., false),
        (0., 0., 40., false),
        (0., 0., 0., true),
    ] {
        session.model.hue_adjustment_red = hue;
        session.model.saturation_adjustment_blue = saturation;
        session.model.defringe_purple_amount = defringe;
        session.model.black_white = if bw {
            raw_core::types::BlackWhiteMode::On
        } else {
            raw_core::types::BlackWhiteMode::Off
        };
        session.model.gray_mixer_red = if bw { 30. } else { 0. };
        session.update_gpu(&CancelToken::new()).unwrap().unwrap();
        assert_eq!(
            session.prefix, prefix,
            "interactive controls must never develop the sensor"
        );
        let gpu = session
            .live
            .render_to_buffer(&session.ctx, &session.inputs, &CancelToken::new())
            .unwrap()
            .unwrap();
        let (_, _, cpu) = raw_core::pipeline::render_from_raw_with_quality_and_source(
            session.raw.as_ref().unwrap(),
            &session.model,
            raw_core::pipeline::RenderQuality::Amaze,
            Some(raw_core::pipeline::RawInput::Bytes {
                bytes: &session.bytes,
                ext: &session.ext,
            }),
        )
        .unwrap();
        assert_eq!(gpu.len(), cpu.len());
        let worst = gpu
            .iter()
            .zip(&cpu)
            .map(|(a, b)| a.abs_diff(*b))
            .max()
            .unwrap();
        assert!(worst <= 2, "HSL/defringe/B&W CPU-GPU error {worst}");
        if hue == 0. && saturation == 0. && defringe == 0. && !bw {
            baseline = cpu;
        } else if hue != 0. || bw {
            assert_ne!(
                cpu, baseline,
                "the colored RAW must exercise the edited pass"
            );
        }
    }
    std::fs::remove_file(path).unwrap();
}

#[test]
fn cancelled_refine_preserves_resident_prefix_and_final_refine_applies_cpu_controls() {
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../../test-fixtures/batch-transfer/source.dng");
    let xml = "<rdf:Description xmlns:rdf=\"http://www.w3.org/1999/02/22-rdf-syntax-ns#\"/>";
    let mut session = Session::open(path.to_str().unwrap(), xml, 2048).unwrap();
    let token = CancelToken::new();
    let prefix = session.prefix.clone();
    session.model.capture_sharpening_amount = 50.;
    assert!(session.update_gpu(&token).unwrap().is_some());
    assert_eq!(
        session.prefix, prefix,
        "fast phase must stay on the resident viewport"
    );
    let mut preparation = session.preparation().unwrap();
    token.cancel();
    assert!(!preparation.run(&token).unwrap());
    assert!(!session.apply_preparation(&mut preparation, &token).unwrap());
    assert_eq!(
        session.prefix, prefix,
        "cancelled work must not replace the resident upload"
    );
    token
        .flag()
        .store(false, std::sync::atomic::Ordering::Release);
    assert!(preparation.run(&token).unwrap());
    assert!(session.apply_preparation(&mut preparation, &token).unwrap());
    session.update_gpu(&token).unwrap().unwrap();
    assert_eq!(session.prefix.capture_sharpening_amount, 50.);
    let gpu = session
        .live
        .render_to_buffer(&session.ctx, &session.inputs, &token)
        .unwrap()
        .unwrap();
    let (_, _, cpu) = raw_core::pipeline::render_from_raw_with_quality_and_source(
        session.raw.as_ref().unwrap(),
        &session.model,
        raw_core::pipeline::RenderQuality::Amaze,
        Some(raw_core::pipeline::RawInput::Bytes {
            bytes: &session.bytes,
            ext: &session.ext,
        }),
    )
    .unwrap();
    assert!(gpu.iter().zip(cpu).all(|(a, b)| a.abs_diff(b) <= 2));
}

#[test]
fn cpu_preparation_outlives_its_source_session_and_cannot_replace_a_new_photo() {
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../../test-fixtures/batch-transfer/source.dng");
    let xml = "<rdf:Description xmlns:rdf=\"http://www.w3.org/1999/02/22-rdf-syntax-ns#\"/>";
    let mut session = Session::open(path.to_str().unwrap(), xml, 2048).unwrap();
    let context = Rc::clone(&session.ctx);
    session.model.capture_sharpening_amount = 50.;
    let mut preparation = session.preparation().unwrap();
    let start = std::sync::Arc::new(std::sync::Barrier::new(2));
    let worker_start = start.clone();
    let worker = std::thread::spawn(move || {
        worker_start.wait();
        assert!(preparation.run(&CancelToken::new()).unwrap());
        preparation
    });
    session.model.exposure = 1.25;
    session.update_gpu(&CancelToken::new()).unwrap().unwrap();
    drop(session);
    start.wait();
    let mut prepared = worker.join().unwrap();
    let mut replacement =
        Session::open_with_context(context, path.to_str().unwrap(), xml, 2048).unwrap();
    assert!(!replacement
        .apply_preparation(&mut prepared, &CancelToken::new())
        .unwrap());
    assert_eq!(replacement.prefix.capture_sharpening_amount, 0.);
    replacement
        .update_gpu(&CancelToken::new())
        .unwrap()
        .unwrap();
}
