//! A real colored RAW through the capture decode (#5380): capture-stage edits
//! refine on the CPU into a new decode and are never re-applied on the GPU,
//! and a white-balance drag renders through the creative stage without
//! re-decoding or allocating.
use super::*;
use raw_core::test_support::capture_seam::{at, max_step, NEUTRAL_XMP as NEUTRAL};
use raw_core::test_support::synth_chart::{ChartEncoding, SyntheticColorChart};

fn chart(name: &str) -> (std::path::PathBuf, Vec<u8>) {
    let bytes = SyntheticColorChart {
        patch_size: 128,
        guard: 4,
        encoding: ChartEncoding::Camera,
        ..Default::default()
    }
    .write_to_bytes();
    let path = std::env::temp_dir().join(format!("{name}-{}.dng", std::process::id()));
    std::fs::write(&path, &bytes).unwrap();
    (path, bytes)
}

fn frame(session: &mut Session) -> Vec<u8> {
    let token = CancelToken::new();
    session.update_gpu(&token).unwrap().unwrap();
    let rgb = session
        .live
        .render_to_buffer(&session.ctx, &session.inputs, &token)
        .unwrap()
        .unwrap();
    let (w, h) = session.live.dims();
    raw_core::image::apply_orientation(&rgb, w, h, session.orientation()).2
}

fn develop(session: &Session) -> Vec<u8> {
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
    assert_eq!(session.oriented_dims(), (w, h));
    cpu
}

#[test]
fn capture_sharpening_refines_into_the_decode_and_is_never_reapplied() {
    let (path, bytes) = chart("capture-refine");
    let mut session = Session::open(path.to_str().unwrap(), NEUTRAL, 2048).unwrap();
    let token = CancelToken::new();
    let unsharpened = frame(&mut session);
    assert!(max_step(&unsharpened, &develop(&session)) <= 1);

    session.model.capture_sharpening_amount = 80.;
    session.model.capture_sharpening_sigma = 1.2;
    assert!(session.needs_preparation());
    assert_eq!(
        frame(&mut session),
        unsharpened,
        "the GPU must not run a capture stage over a capture decode"
    );

    let mut preparation = session.preparation().unwrap();
    assert!(preparation.run(&token).unwrap());
    assert!(session.apply_preparation(&mut preparation, &token).unwrap());
    assert!(!session.needs_preparation());
    assert_eq!(session.prefix.capture_sharpening_amount, 80.);
    let sharpened = frame(&mut session);
    assert_ne!(
        sharpened, unsharpened,
        "the refine must bake the sharpening"
    );
    let step = max_step(&sharpened, &develop(&session));
    assert!(step <= 1, "refined capture vs develop: {step} steps");

    session.model.capture_sharpening_amount = 0.;
    session.update().unwrap();
    assert_eq!(frame(&mut session), unsharpened);
    assert_eq!(std::fs::read(&path).unwrap(), bytes);
    std::fs::remove_file(path).unwrap();
}

#[test]
fn a_white_balance_drag_runs_the_creative_stage_without_redecoding_or_allocating() {
    let (path, bytes) = chart("capture-wb");
    let mut session = Session::open(path.to_str().unwrap(), NEUTRAL, 2048).unwrap();
    let prefix = session.prefix.clone();
    let as_shot = session.as_shot_white_balance_values();
    assert_eq!(session.white_balance_values(), as_shot);
    let mut allocations = None;
    let mut previous = frame(&mut session);
    for temperature in [as_shot.0 - 800., as_shot.0 + 800., 2000., 50000., as_shot.0] {
        session.model = at(&session.model, (temperature, as_shot.1));
        assert!(
            session.preparation().is_none(),
            "a WB tick must not re-decode"
        );
        let shown = frame(&mut session);
        assert!(session.inputs.creative.is_some());
        let step = max_step(&shown, &develop(&session));
        assert!(step <= 1, "{temperature} K: {step} steps");
        if temperature != as_shot.0 {
            assert_ne!(shown, previous, "{temperature} K must move the render");
        }
        previous = shown;
        let count = session.live.pool_alloc_count(&session.ctx);
        assert_eq!(*allocations.get_or_insert(count), count, "{temperature} K");
    }
    assert_eq!(session.prefix, prefix);
    assert_eq!(std::fs::read(&path).unwrap(), bytes);
    std::fs::remove_file(path).unwrap();
}

/// The capture decode is uploaded in sensor framing and oriented at present:
/// a portrait-tagged RAW reports its upright aspect, presents through the
/// orientation, and an off-centre mask lands where the develop puts it.
#[test]
fn a_rotated_raw_orients_at_present_and_masks_follow_the_upright_frame() {
    use raw_core::types::{LocalAdjustment, Mask, PartialAdjustments, Point2};
    let bytes = raw_core::test_support::synth_dng::SyntheticGreyDng {
        width: 96,
        height: 64,
        orientation: Some(6),
        ..Default::default()
    }
    .write_to_bytes();
    let path = std::env::temp_dir().join(format!("capture-rotated-{}.dng", std::process::id()));
    std::fs::write(&path, &bytes).unwrap();
    let mut session = Session::open(path.to_str().unwrap(), NEUTRAL, 2048).unwrap();
    assert_eq!(session.live.dims(), (96, 64));
    assert!((session.uncropped_aspect() - 64. / 96.).abs() < 1e-6);
    assert!(session.geometry().is_active());
    session.model.local_adjustments = vec![LocalAdjustment {
        mask: Mask::Radial {
            center: Point2::new(0.3, 0.25),
            radii: Point2::new(0.2, 0.15),
            angle: 0.0,
            feather: 0.5,
            invert: false,
        },
        range: None,
        adjustments: PartialAdjustments {
            exposure: Some(1.5),
            ..Default::default()
        },
    }];
    assert!(session.preparation().is_none(), "a mask is a live control");
    let unmasked = {
        let mut plain = session.model.clone();
        plain.local_adjustments.clear();
        plain
    };
    let shown = frame(&mut session);
    let step = max_step(&shown, &develop(&session));
    assert!(step <= 1, "rotated mask vs develop: {step} steps");
    session.model = unmasked;
    assert_ne!(frame(&mut session), shown, "the mask must move the render");
    std::fs::remove_file(path).unwrap();
}
