use super::*;

#[test]
#[ignore = "requires physical RAW; explicit invocation fails if absent"]
fn inactive_film_metadata_matches_deselected_look_and_retained_ticks() {
    let path = crate::test_support::fixtures::require_raw("test_0007.DNG");
    let bytes = std::fs::read(&path).unwrap();
    let original_hash = blake3::hash(&bytes);
    let raw = crate::decode::decode_bytes(&bytes, "dng").unwrap();
    let source = RawInput::Bytes {
        bytes: &bytes,
        ext: "dng",
    };
    let film = FilmLut {
        size: 3,
        data: crate::view::auto_profile::lut::ColorLut::identity(3).data,
    };
    let baseline = super::super::render_from_raw_with_auto_fit(
        &raw,
        &AdjustmentModel::default(),
        RenderQuality::Preview,
        Some(source),
        Some(768),
        None,
    )
    .unwrap();
    assert_eq!(
        baseline.3,
        Some(crate::view::auto_profile::AutoFitOutcome::Applied),
        "real Auto fit must engage"
    );
    for (strength, supplied) in [(0., Some(&film)), (0., None), (100., None)] {
        let model = AdjustmentModel {
            film_look: "loaded-look".into(),
            film_strength: strength,
            ..Default::default()
        };
        let direct = super::super::render_from_raw_with_auto_fit(
            &raw,
            &model,
            RenderQuality::Preview,
            Some(source),
            Some(768),
            supplied,
        )
        .unwrap();
        assert_eq!(
            (direct.0, direct.1, direct.3),
            (baseline.0, baseline.1, baseline.3)
        );
        assert_eq!(direct.2.len(), baseline.2.len());
        let changed = direct
            .2
            .iter()
            .zip(&baseline.2)
            .filter(|(a, b)| a != b)
            .count();
        assert_eq!(
            changed,
            0,
            "inactive film differs from deselected look: strength={strength}, supplied={}",
            supplied.is_some()
        );
        let (mut preview, (w, h, first, fit)) = CpuPreview::open(
            &raw,
            source,
            model.clone(),
            RenderQuality::Preview,
            768,
            supplied,
        )
        .unwrap();
        assert_eq!((w, h, fit), (baseline.0, baseline.1, baseline.3));
        assert!(
            first == baseline.2,
            "inactive first frame differs from baseline"
        );
        let next = preview
            .render(
                &raw,
                source,
                model,
                RenderQuality::Preview,
                768,
                supplied,
                CancelToken::never(),
            )
            .unwrap();
        assert!(
            next.2 == baseline.2,
            "inactive retained tick differs from baseline"
        );
    }
    assert_eq!(blake3::hash(&std::fs::read(path).unwrap()), original_hash);
}

#[test]
#[ignore = "requires physical RAW; explicit invocation fails if absent"]
fn real_default_auto_film_hot_repeat_matches_first_render() {
    let path = crate::test_support::fixtures::require_raw("test_0017.dng");
    let bytes = std::fs::read(&path).unwrap();
    let original_hash = blake3::hash(&bytes);
    let raw = crate::decode::decode_bytes(&bytes, "dng").unwrap();
    let source = RawInput::Bytes {
        bytes: &bytes,
        ext: "dng",
    };
    // A high-key look exercises the identity curve's shoulder above 0.95.
    let film = FilmLut {
        size: 3,
        data: crate::view::auto_profile::lut::ColorLut::identity(3)
            .data
            .into_iter()
            .map(|value| 0.96 + 0.04 * value)
            .collect(),
    };
    let model = AdjustmentModel::default();
    let (mut resident, (w, h, first, fit)) = CpuPreview::open(
        &raw,
        source,
        model.clone(),
        RenderQuality::Preview,
        128,
        Some(&film),
    )
    .unwrap();
    assert_eq!(
        fit,
        Some(crate::view::auto_profile::AutoFitOutcome::Applied),
        "the real embedded-JPEG fit must engage"
    );
    assert!(resident.context.profile_curve.is_some());
    assert!(resident.context.profile_lut.is_some());
    let prefix = resident.prefix.pixels.as_ptr();
    let working = resident.working.pixels.as_ptr();
    for amount in [40., 0., 150., 40.] {
        let edited = AdjustmentModel {
            sharpen_amount: amount,
            ..model.clone()
        };
        let actual = resident
            .render(
                &raw,
                source,
                edited.clone(),
                RenderQuality::Preview,
                128,
                Some(&film),
                CancelToken::never(),
            )
            .unwrap();
        let direct = super::super::render_from_raw_with_auto_fit(
            &raw,
            &edited,
            RenderQuality::Preview,
            Some(source),
            Some(128),
            Some(&film),
        )
        .unwrap();
        assert_eq!((actual.0, actual.1, actual.3), (w, h, fit));
        assert_eq!((direct.0, direct.1, direct.3), (w, h, fit));
        assert_eq!(actual.2.len(), direct.2.len());
        let differing = actual
            .2
            .iter()
            .zip(&direct.2)
            .filter(|(a, b)| a != b)
            .count();
        assert_eq!(
            differing, 0,
            "retained/direct channel mismatches, amount {amount}"
        );
        if amount == model.sharpen_amount {
            assert!(actual.2 == first, "default tick differs from first frame");
        }
        assert_eq!(prefix, resident.prefix.pixels.as_ptr());
        assert_eq!(working, resident.working.pixels.as_ptr());
    }
    assert_eq!(blake3::hash(&std::fs::read(path).unwrap()), original_hash);
}
