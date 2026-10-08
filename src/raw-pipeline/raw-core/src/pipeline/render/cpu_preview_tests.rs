use super::*;
use crate::test_support::synth_chart::{ChartEncoding, SyntheticColorChart};
use crate::types::adjustment::Profile;

#[test]
fn resident_detail_bytes_match_legacy_and_upstream_edits_rebuild() {
    let bytes = SyntheticColorChart {
        patch_size: 12,
        guard: 4,
        encoding: ChartEncoding::Camera,
        ..Default::default()
    }
    .write_to_bytes();
    let raw = crate::decode::decode_bytes(&bytes, "dng").unwrap();
    let source = RawInput::Bytes {
        bytes: &bytes,
        ext: "dng",
    };
    for profile in [Profile::Auto, Profile::Neutral] {
        let initial = AdjustmentModel {
            profile,
            ..Default::default()
        };
        let (mut resident, w, h, pixels, fit) = CpuPreview::open(
            &raw,
            source,
            initial.clone(),
            RenderQuality::Preview,
            80,
            None,
        )
        .unwrap();
        let legacy = super::super::render_from_raw_with_auto_fit(
            &raw,
            &initial,
            RenderQuality::Preview,
            Some(source),
            Some(80),
            None,
        )
        .unwrap();
        assert_eq!((w, h, pixels, fit), legacy);
        for (sharpen, luma, color, exposure, cap) in [
            (0., 0., 0., 0., 80),
            (150., 0., 0., 0., 80),
            (40., 100., 25., 0., 80),
            (40., 0., 100., 0., 80),
            (40., 0., 25., 0.7, 80),
            (40., 0., 25., 0.7, 64),
        ] {
            let model = AdjustmentModel {
                profile,
                sharpen_amount: sharpen,
                nr_luminance: luma,
                nr_color: color,
                exposure,
                ..Default::default()
            };
            let prefix_pointer = resident.prefix.pixels.as_ptr();
            let working_pointer = resident.working.pixels.as_ptr();
            let same_key = upstream_key(model.clone()) == resident.key && cap == resident.cap;
            let actual = resident
                .render(
                    &raw,
                    source,
                    model.clone(),
                    RenderQuality::Preview,
                    cap,
                    None,
                    CancelToken::never(),
                )
                .unwrap();
            let expected = super::super::render_from_raw_with_auto_fit(
                &raw,
                &model,
                RenderQuality::Preview,
                Some(source),
                Some(cap),
                None,
            )
            .unwrap();
            assert_eq!(
                actual, expected,
                "{profile:?} {sharpen}/{luma}/{color}/{exposure}/{cap}"
            );
            if same_key {
                assert_eq!(prefix_pointer, resident.prefix.pixels.as_ptr());
                assert_eq!(working_pointer, resident.working.pixels.as_ptr());
            }
        }
    }
}

#[test]
fn cancelled_tick_preserves_resident_prefix_and_next_render() {
    let bytes = SyntheticColorChart {
        patch_size: 12,
        guard: 4,
        encoding: ChartEncoding::Camera,
        ..Default::default()
    }
    .write_to_bytes();
    let raw = crate::decode::decode_bytes(&bytes, "dng").unwrap();
    let source = RawInput::Bytes {
        bytes: &bytes,
        ext: "dng",
    };
    let model = AdjustmentModel::default();
    let (mut resident, _, _, _, _) = CpuPreview::open(
        &raw,
        source,
        model.clone(),
        RenderQuality::Preview,
        80,
        None,
    )
    .unwrap();
    let original = resident.prefix.pixels.clone();
    let flag = std::sync::atomic::AtomicBool::new(true);
    assert!(matches!(
        resident.render(
            &raw,
            source,
            model.clone(),
            RenderQuality::Preview,
            80,
            None,
            CancelToken::new(&flag)
        ),
        Err(Error::Cancelled)
    ));
    assert_eq!(resident.prefix.pixels, original);
    let actual = resident
        .render(
            &raw,
            source,
            model.clone(),
            RenderQuality::Preview,
            80,
            None,
            CancelToken::never(),
        )
        .unwrap();
    let expected = super::super::render_from_raw_with_auto_fit(
        &raw,
        &model,
        RenderQuality::Preview,
        Some(source),
        Some(80),
        None,
    )
    .unwrap();
    assert_eq!(actual, expected);
}

#[test]
#[cfg_attr(not(feature = "fixtures"), ignore)]
fn real_fitted_auto_film_local_crop_and_orientation_match_legacy() {
    use crate::image::ExifOrientation;
    use crate::types::local_adjustment::{LocalAdjustment, PartialAdjustments, Point2};
    let path = crate::test_support::fixtures::require_raw("test_0017.dng");
    let bytes = std::fs::read(path).unwrap();
    let mut raw = crate::decode::decode_bytes(&bytes, "dng").unwrap();
    let source = RawInput::Bytes {
        bytes: &bytes,
        ext: "dng",
    };
    let mut film = FilmLut {
        size: 3,
        data: crate::view::auto_profile::lut::ColorLut::identity(3).data,
    };
    for rgb in film.data.chunks_exact_mut(3) {
        rgb[1] *= 0.87;
    }
    let base = AdjustmentModel::default();
    let (mut resident, _, _, _, fit) = CpuPreview::open(
        &raw,
        source,
        base.clone(),
        RenderQuality::Preview,
        128,
        None,
    )
    .unwrap();
    assert_eq!(
        fit,
        Some(true),
        "authentic embedded-JPEG Auto fit must engage"
    );
    assert!(resident.context.profile_curve.is_some());
    assert!(resident.context.profile_lut.is_some());
    let authored = AdjustmentModel {
        sharpen_amount: 90.,
        nr_color: 60.,
        nr_luminance: 25.,
        grain_amount: 20.,
        vignette_amount: -20.,
        film_strength: 65.,
        crop: crate::types::Crop {
            left: 0.1,
            top: 0.07,
            right: 0.91,
            bottom: 0.88,
            angle: 0.,
        },
        local_adjustments: vec![LocalAdjustment::radial(
            Point2::new(0.37, 0.61),
            Point2::new(0.33, 0.21),
            PartialAdjustments {
                exposure: Some(0.65),
                saturation: Some(15.),
                ..Default::default()
            },
        )],
        ..base
    };
    let file = std::env::temp_dir().join(format!("maple-cpu-preview-{}.xmp", std::process::id()));
    let sidecar = format!(
        r#"<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><rdf:Description xmlns:crs="http://ns.adobe.com/camera-raw-settings/1.0/" xmlns:papp="https://maple.photos/app/1.0/"{}>{}</rdf:Description></rdf:RDF></x:xmpmeta>"#,
        crate::xmp::serialize(&authored),
        crate::xmp::serialize_local_adjustments(&authored, "")
    );
    std::fs::write(&file, sidecar).unwrap();
    let authored = crate::xmp::parse(&std::fs::read_to_string(&file).unwrap()).unwrap();
    std::fs::remove_file(file).unwrap();
    assert_eq!(
        authored.local_adjustments.len(),
        1,
        "actual sidecar must retain the authored mask"
    );
    for orientation in [
        ExifOrientation::Normal,
        ExifOrientation::HorizontalFlip,
        ExifOrientation::Rotate180,
        ExifOrientation::VerticalFlip,
        ExifOrientation::Transpose,
        ExifOrientation::Rotate90,
        ExifOrientation::Transverse,
        ExifOrientation::Rotate270,
    ] {
        raw.orientation = orientation;
        for amount in [0., 150.] {
            let model = AdjustmentModel {
                sharpen_amount: amount,
                ..authored.clone()
            };
            let actual = resident
                .render(
                    &raw,
                    source,
                    model.clone(),
                    RenderQuality::Preview,
                    128,
                    Some(&film),
                    CancelToken::never(),
                )
                .unwrap();
            let legacy = super::super::render_from_raw_with_auto_fit(
                &raw,
                &model,
                RenderQuality::Preview,
                Some(source),
                Some(128),
                Some(&film),
            )
            .unwrap();
            assert_eq!(actual, legacy, "{orientation:?}, sharpen={amount}");
            assert_eq!(actual.3, Some(true));
        }
    }
    for rgb in film.data.chunks_exact_mut(3) {
        rgb[0] *= 0.8;
    }
    let mut changed = authored;
    changed.local_adjustments[0].adjustments.exposure = Some(-0.45);
    let actual = resident
        .render(
            &raw,
            source,
            changed.clone(),
            RenderQuality::Amaze,
            96,
            Some(&film),
            CancelToken::never(),
        )
        .unwrap();
    let legacy = super::super::render_from_raw_with_auto_fit(
        &raw,
        &changed,
        RenderQuality::Amaze,
        Some(source),
        Some(96),
        Some(&film),
    )
    .unwrap();
    assert_eq!(actual, legacy);
}

#[test]
fn replacement_source_rebuilds_before_detail_reuse() {
    let first_bytes = SyntheticColorChart {
        patch_size: 12,
        guard: 4,
        encoding: ChartEncoding::Camera,
        ..Default::default()
    }
    .write_to_bytes();
    let second_bytes = SyntheticColorChart {
        patch_size: 16,
        guard: 4,
        encoding: ChartEncoding::Camera,
        ..Default::default()
    }
    .write_to_bytes();
    let first = crate::decode::decode_bytes(&first_bytes, "dng").unwrap();
    let second = crate::decode::decode_bytes(&second_bytes, "dng").unwrap();
    let first_source = RawInput::Bytes {
        bytes: &first_bytes,
        ext: "dng",
    };
    let second_source = RawInput::Bytes {
        bytes: &second_bytes,
        ext: "dng",
    };
    let initial = AdjustmentModel::default();
    let (mut resident, _, _, _, _) = CpuPreview::open(
        &first,
        first_source,
        initial.clone(),
        RenderQuality::Preview,
        80,
        None,
    )
    .unwrap();
    assert!(!resident.source.matches(&second, second_source));
    let model = AdjustmentModel {
        nr_color: 100.,
        ..initial
    };
    let actual = resident
        .render(
            &second,
            second_source,
            model.clone(),
            RenderQuality::Preview,
            80,
            None,
            CancelToken::never(),
        )
        .unwrap();
    let expected = super::super::render_from_raw_with_auto_fit(
        &second,
        &model,
        RenderQuality::Preview,
        Some(second_source),
        Some(80),
        None,
    )
    .unwrap();
    assert_eq!(actual, expected);
    assert!(resident.source.matches(&second, second_source));
    assert!(!resident.source.matches(&first, first_source));
}

#[test]
#[cfg(feature = "fixtures")]
fn real_default_auto_hot_repeat_and_edited_replay_match_legacy() {
    let path = crate::test_support::fixtures::require_raw("test_0017.dng");
    let bytes = std::fs::read(path).unwrap();
    let raw = crate::decode::decode_bytes(&bytes, "dng").unwrap();
    let source = RawInput::Bytes {
        bytes: &bytes,
        ext: "dng",
    };
    let model = AdjustmentModel::default();
    let (mut resident, w, h, pixels, fit) = CpuPreview::open(
        &raw,
        source,
        model.clone(),
        RenderQuality::Preview,
        128,
        None,
    )
    .unwrap();
    assert_eq!(fit, Some(true));
    assert!(resident.context.profile_curve.is_some());
    assert!(resident.context.profile_lut.is_some());
    let initial = (w, h, pixels, fit);
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
                None,
                CancelToken::never(),
            )
            .unwrap();
        let expected = super::super::render_from_raw_with_auto_fit(
            &raw,
            &edited,
            RenderQuality::Preview,
            Some(source),
            Some(128),
            None,
        )
        .unwrap();
        assert_eq!(actual, expected, "amount {amount}");
        if amount == model.sharpen_amount {
            assert_eq!(actual, initial);
        }
    }
}
