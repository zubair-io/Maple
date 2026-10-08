//! Actual Rust-owned native-detail session controls; no JS or filesystem mock.
use super::*;
use raw_core::test_support::synth_chart::SyntheticColorChart;

#[test]
fn native_detail_session_retains_one_owned_source_across_native_pan_overlap() {
    let bytes = SyntheticColorChart {
        patch_size: 80,
        guard: 8,
        ..Default::default()
    }
    .write_to_bytes();
    let mut session = NativeDetailSession::new(&bytes, "dng").unwrap();
    let original = session.raw.raw_data.clone();
    let source = Arc::downgrade(&session.raw);
    assert_eq!(Arc::strong_count(&session.raw), 1);
    let first = session
        .render_tile(None, &[133, 117, 101, 101], 128, true, &[])
        .unwrap();
    // One session owner and its real full-native Auto context; no RAW clone.
    assert_eq!(Arc::strong_count(&session.raw), 2);
    assert!(first.rgb.iter().any(|v| *v != 0));
    let next = session
        .render_tile(None, &[181, 117, 101, 101], 128, true, &[])
        .unwrap();
    assert_eq!(Arc::strong_count(&session.raw), 2);
    for y in 0..101 {
        let first_overlap = &first.rgb[(y * 101 + 48) * 3..(y * 101 + 101) * 3];
        let next_overlap = &next.rgb[(y * 101) * 3..(y * 101 + 53) * 3];
        assert_eq!(first_overlap, next_overlap, "native pan overlap row {y}");
    }
    assert_eq!(session.raw.raw_data, original);
    drop(session);
    assert!(
        source.upgrade().is_none(),
        "session retirement releases native context/source"
    );
}

#[test]
fn native_detail_session_model_change_replaces_frame_context_and_tail() {
    let bytes = SyntheticColorChart {
        patch_size: 80,
        guard: 8,
        ..Default::default()
    }
    .write_to_bytes();
    let mut session = NativeDetailSession::new(&bytes, "dng").unwrap();
    let rect = [133, 117, 101, 101];
    let before = session
        .render_tile(None, &rect, 128, false, &[])
        .unwrap()
        .rgb;
    let xmp = Some(r#"<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><rdf:Description xmlns:crs="http://ns.adobe.com/camera-raw-settings/1.0/" crs:Exposure2012="1"/></rdf:RDF></x:xmpmeta>"#.to_owned());
    let edited = session
        .render_tile(xmp.clone(), &rect, 128, false, &[])
        .unwrap()
        .rgb;
    assert_ne!(
        before, edited,
        "the changed full model must affect the actual tile"
    );
    assert_eq!(
        Arc::strong_count(&session.raw),
        2,
        "old context retired before replacement"
    );
    let repeat = session
        .render_tile(xmp, &rect, 128, false, &[])
        .unwrap()
        .rgb;
    assert_eq!(edited, repeat);
    assert_eq!(Arc::strong_count(&session.raw), 2);
}

#[test]
fn native_detail_preparation_admits_existing_limit_before_native_sampler() {
    use raw_core::test_support::synth_dng::SyntheticGreyDng;
    let bytes = SyntheticGreyDng {
        width: 22_000,
        height: 385,
        ..Default::default()
    }
    .write_to_bytes();
    let session = NativeDetailSession::new(&bytes, "dng").unwrap();
    let model = raw_core::xmp::AdjustmentModel::default();
    assert!(
        pipeline::HighlightFrameContext::preparation_working_pixels(
            &session.raw,
            &model,
            RenderQuality::Auto,
        ) > MAX_WORKING_PIXELS
    );
    // The production retained entry and unchanged Web8M limit: no native
    // prefix allocation or retained source context may survive rejection.
    let error = pipeline::render_detail_base_retained(
        Arc::clone(&session.raw),
        &model,
        RawInput::Bytes {
            bytes: &session.bytes,
            ext: &session.ext,
        },
        DetailRenderOptions {
            quality: RenderQuality::Preview,
            max_long_edge: 128,
            film_lut: None,
        },
        MAX_WORKING_PIXELS,
        None,
    )
    .err()
    .expect("oversized native sampler must fail before preparation");
    assert!(error
        .to_string()
        .contains("preparation exceeds working-pixel budget"));
    assert_eq!(Arc::strong_count(&session.raw), 1);
}
