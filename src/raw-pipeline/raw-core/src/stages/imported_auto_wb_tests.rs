use super::*;
use crate::{pipeline, xmp, xmp::AutoExposureMode};

fn raw() -> RawImage {
    crate::decode::decode(
        &std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../../test-fixtures/batch-transfer/source.dng"),
    )
    .unwrap()
}

fn read_sidecar(contents: &str) -> AdjustmentModel {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("source.xmp");
    std::fs::write(&path, contents).unwrap();
    xmp::parse(&std::fs::read_to_string(path).unwrap()).unwrap()
}

#[test]
fn imported_auto_intent_round_trips_real_sidecars_and_numeric_components_win() {
    let model = read_sidecar(r#"<x crs:WhiteBalance="Auto"/>"#);
    assert!(needs_resolution(&model));
    let round_trip = read_sidecar(&format!("<x{}/>", xmp::serialize(&model)));
    assert!(needs_resolution(&round_trip));
    for name in ["As Shot", "Custom", "Daylight", "unknown"] {
        assert!(!needs_resolution(&read_sidecar(&format!(
            r#"<x crs:WhiteBalance="{name}"/>"#
        ))));
    }
    for component in [r#"crs:Temperature="5300""#, r#"crs:Tint="17""#] {
        for xml in [
            format!(r#"<x {component} crs:WhiteBalance="Auto"/>"#),
            format!(r#"<x crs:WhiteBalance="Auto" {component}/>"#),
        ] {
            let model = read_sidecar(&xml);
            assert!(!needs_resolution(&model));
            if model.temperature_seen {
                assert_eq!(model.temperature, 5300.);
            }
            if model.tint_seen {
                assert_eq!(model.tint, 17.);
            }
        }
    }
}

#[test]
fn ordinary_and_explicit_models_are_borrowed_without_analysis() {
    let raw = raw();
    for model in [
        AdjustmentModel::default(),
        AdjustmentModel {
            unresolved_auto_wb: true,
            temperature_seen: true,
            temperature: 5300.,
            ..Default::default()
        },
    ] {
        let flag = std::sync::atomic::AtomicBool::new(true);
        assert!(matches!(
            resolve(&raw, &model, CancelToken::new(&flag)).unwrap(),
            Cow::Borrowed(_)
        ));
    }
    let model = read_sidecar(r#"<x crs:WhiteBalance="Auto"/>"#);
    let flag = std::sync::atomic::AtomicBool::new(true);
    assert!(matches!(
        resolve(&raw, &model, CancelToken::new(&flag)),
        Err(Error::Cancelled)
    ));
}

#[test]
fn imported_estimate_matches_existing_auto_without_applying_tone_or_mutating_input() {
    let raw = raw();
    let original = read_sidecar(
        r#"<x crs:WhiteBalance="Auto" crs:Exposure2012="2" crs:Contrast2012="-60" crs:Dehaze="25"/>"#,
    );
    let before = original.clone();
    let expected =
        super::super::auto_adjustments::compute_auto_adjustments(&raw, &AdjustmentModel::default())
            .unwrap();
    let resolved = resolve(&raw, &original, CancelToken::never()).unwrap();
    assert_eq!(original, before);
    assert_eq!(
        (resolved.temperature, resolved.tint),
        (expected.temperature, expected.tint)
    );
    assert_eq!(
        (resolved.exposure, resolved.contrast, resolved.dehaze),
        (2., -60., 25.)
    );
    assert_eq!(resolved.auto_exposure, AutoExposureMode::On);
    assert!(!needs_resolution(&resolved));
    assert_eq!(resolved.wb_scale_version, WbScaleVersion::V5);
    assert!(matches!(
        resolve(&raw, &resolved, CancelToken::never()).unwrap(),
        Cow::Borrowed(_)
    ));
}

#[test]
fn imported_auto_full_and_sized_equal_explicit_resolved_pair() {
    let raw = raw();
    let imported = read_sidecar(r#"<x crs:WhiteBalance="Auto"/>"#);
    let resolved = resolve(&raw, &imported, CancelToken::never()).unwrap();
    let explicit = read_sidecar(&format!(
        r#"<x crs:WhiteBalance="Auto" crs:Temperature="{}" crs:Tint="{}"/>"#,
        resolved.temperature, resolved.tint
    ));
    for ae in [AutoExposureMode::On, AutoExposureMode::Off] {
        let a = AdjustmentModel {
            auto_exposure: ae,
            ..imported.clone()
        };
        let b = AdjustmentModel {
            auto_exposure: ae,
            ..explicit.clone()
        };
        for cap in [None, Some(16)] {
            let render = |model| match cap {
                None => pipeline::develop_scene_linear_from_raw_with_quality(
                    &raw,
                    model,
                    RenderQuality::Amaze,
                ),
                Some(edge) => pipeline::develop_scene_linear_sized_from_raw_with_quality(
                    &raw,
                    model,
                    RenderQuality::Amaze,
                    edge,
                ),
            };
            let a = render(&a).unwrap();
            let b = render(&b).unwrap();
            assert_eq!((a.width, a.height, a.space), (b.width, b.height, b.space));
            assert_eq!(a.pixels, b.pixels);
        }
    }
}

#[test]
fn session_keeps_resolved_pair_for_later_requests_without_analysis() {
    let raw = raw();
    let original = read_sidecar(r#"<x crs:WhiteBalance="Auto"/>"#);
    let mut cache = CachedEstimate::default();
    let mut first = original.clone();
    cache
        .resolve_in_place(&raw, &mut first, CancelToken::never())
        .unwrap();
    let pair = (first.temperature, first.tint);
    let mut next = AdjustmentModel {
        exposure: 2.,
        ..original
    };
    let cancelled = std::sync::atomic::AtomicBool::new(true);
    // An estimator call would fail immediately with this token.
    cache
        .resolve_in_place(&raw, &mut next, CancelToken::new(&cancelled))
        .unwrap();
    assert_eq!(pair, (next.temperature, next.tint));
    assert_eq!(next.exposure, 2.);
}

#[test]
fn imported_auto_tile_equals_full_frame_estimated_pair() {
    let raw = raw();
    let imported = read_sidecar(r#"<x crs:WhiteBalance="Auto" papp:AutoExposure="Off"/>"#);
    let resolved = resolve(&raw, &imported, CancelToken::never()).unwrap();
    let render = |model| {
        pipeline::render_scene_linear_tile_from_raw_with_quality(
            &raw,
            model,
            pipeline::TileRect {
                src_x: 0,
                src_y: 0,
                src_w: raw.width as u32,
                src_h: raw.height as u32,
                out_w: 24,
                out_h: 16,
            },
            RenderQuality::Full,
        )
        .unwrap()
    };
    assert_eq!(render(&imported), render(&resolved));
}

#[cfg(feature = "gpu")]
#[test]
fn imported_auto_one_shot_gpu_prefix_equals_resolved_pair() {
    let raw = raw();
    let imported = read_sidecar(r#"<x crs:WhiteBalance="Auto" papp:Profile="Neutral"/>"#);
    let resolved = resolve(&raw, &imported, CancelToken::never()).unwrap();
    let prepare = |model| {
        crate::gpu_host::prepare::develop_render_prefix_rgba(&raw, &[], "dng", model, 16).unwrap()
    };
    let (a, aw, ah, _, aa, an) = prepare(&imported);
    let (b, bw, bh, _, ba, bn) = prepare(&resolved);
    assert_eq!((aw, ah, aa, an), (bw, bh, ba, bn));
    assert_eq!(a, b);
}
