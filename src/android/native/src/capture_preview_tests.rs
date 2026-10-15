//! Real colored RAW, bounded GPU feedback, and exact final CPU-order refinement.
use super::*;
use raw_core::test_support::synth_chart::{ChartEncoding, SyntheticColorChart};

#[test]
fn capture_drag_changes_bounded_gpu_pixels_and_never_reapplies_baked_capture() {
    let bytes = SyntheticColorChart {
        patch_size: 128,
        guard: 4,
        encoding: ChartEncoding::Camera,
        ..Default::default()
    }
    .write_to_bytes();
    let path = std::env::temp_dir().join(format!("capture-fast-{}.dng", std::process::id()));
    std::fs::write(&path, &bytes).unwrap();
    let xml = "<rdf:Description xmlns:rdf=\"http://www.w3.org/1999/02/22-rdf-syntax-ns#\" xmlns:papp=\"http://ns.justmaple.app/photo/1.0/\" papp:Profile=\"Neutral\"/>";
    let mut session = Session::open(path.to_str().unwrap(), xml, 2048).unwrap();
    let token = CancelToken::new();
    session.model.capture_sharpening_amount = 80.;
    session.model.capture_sharpening_sigma = 1.2;
    session.update_gpu(&token).unwrap().unwrap();
    assert!(session.active_fast);
    assert!(
        session
            .frame_parts()
            .0
            .dims()
            .0
            .max(session.frame_parts().0.dims().1)
            <= 512
    );
    assert_eq!(
        session
            .fast
            .as_ref()
            .unwrap()
            .prefix
            .capture_sharpening_amount,
        0.
    );
    let fast = session.fast.as_mut().unwrap();
    let capture = fast.inputs.capture_sharpening.take();
    assert!(capture.is_some());
    let before = fast
        .live
        .render_to_buffer(&session.ctx, &fast.inputs, &token)
        .unwrap()
        .unwrap();
    fast.inputs.capture_sharpening = capture;
    let changed = fast
        .live
        .render_to_buffer(&session.ctx, &fast.inputs, &token)
        .unwrap()
        .unwrap();
    assert_ne!(
        before, changed,
        "the fast phase must visibly apply capture sharpening"
    );

    let mut preparation = session.preparation().unwrap();
    assert!(preparation.run(&token).unwrap());
    assert!(session.apply_preparation(&mut preparation, &token).unwrap());
    session.update_gpu(&token).unwrap().unwrap();
    assert!(!session.active_fast);
    assert!(
        session.inputs.capture_sharpening.is_none(),
        "refined pixels already baked this stage"
    );
    let gpu = session
        .live
        .render_to_buffer(&session.ctx, &session.inputs, &token)
        .unwrap()
        .unwrap();
    let (w, h, cpu) = raw_core::pipeline::render_from_raw_with_quality_and_source(
        session.raw.as_ref().unwrap(),
        &session.model,
        raw_core::pipeline::RenderQuality::Amaze,
        Some(raw_core::pipeline::RawInput::Bytes {
            bytes: &session.bytes,
            ext: &session.ext,
        }),
    )
    .unwrap();
    assert_eq!(session.live.dims(), (w, h));
    assert_eq!(gpu.len(), cpu.len());
    assert!(gpu.iter().zip(cpu).all(|(a, b)| a.abs_diff(b) <= 2));

    let allocations = session
        .fast
        .as_ref()
        .unwrap()
        .live
        .pool_alloc_count(&session.ctx);
    session.model.capture_sharpening_amount = 30.;
    session.model.capture_sharpening_sigma = 1.8;
    session.update_gpu(&token).unwrap().unwrap();
    assert!(session.active_fast);
    assert_eq!(session.prefix.capture_sharpening_amount, 80.);
    let fast = session.fast.as_ref().unwrap();
    assert_eq!(fast.prefix.capture_sharpening_amount, 0.);
    assert_eq!(fast.live.pool_alloc_count(&session.ctx), allocations);
    let next = fast
        .live
        .render_to_buffer(&session.ctx, &fast.inputs, &token)
        .unwrap()
        .unwrap();
    assert_ne!(next, changed);
    session.model.capture_sharpening_amount = 0.;
    session.update_gpu(&token).unwrap().unwrap();
    let (live, inputs) = session.frame_parts();
    assert!(inputs.capture_sharpening.is_none());
    assert_eq!(
        before,
        live.render_to_buffer(&session.ctx, inputs, &token)
            .unwrap()
            .unwrap()
    );
    assert_eq!(std::fs::read(&path).unwrap(), bytes);
    std::fs::remove_file(path).unwrap();
}
