use super::*;
use crate::{cancel::probe::PollProbe, pipeline, xmp, xmp::AutoExposureMode, Error};

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
fn apply_leaves_ordinary_and_authored_models_untouched() {
    let mut cache = CachedEstimate::default();
    cache.pair = Some((5000., 12.));
    for model in [
        AdjustmentModel::default(),
        read_sidecar(r#"<x crs:WhiteBalance="Auto" crs:Temperature="5300"/>"#),
        read_sidecar(r#"<x crs:WhiteBalance="Auto" crs:Tint="17"/>"#),
        read_sidecar(r#"<x crs:WhiteBalance="Auto" crs:Temperature="5300" crs:Tint="17"/>"#),
    ] {
        let mut applied = model.clone();
        cache.apply(&mut applied);
        assert_eq!(applied, model);
    }
}

#[test]
fn ordinary_and_authored_models_are_borrowed_without_analysis() {
    let raw = raw();
    // An estimate would fail at once under this token.
    let cancelled = std::sync::atomic::AtomicBool::new(true);
    for model in [
        AdjustmentModel::default(),
        read_sidecar(r#"<x crs:WhiteBalance="Auto" crs:Temperature="5300"/>"#),
        read_sidecar(r#"<x crs:WhiteBalance="Auto" crs:Tint="17"/>"#),
    ] {
        assert!(matches!(
            resolve(&raw, &model, CancelToken::new(&cancelled)).unwrap(),
            Cow::Borrowed(_)
        ));
    }
    let model = read_sidecar(r#"<x crs:WhiteBalance="Auto"/>"#);
    assert!(matches!(
        resolve(&raw, &model, CancelToken::new(&cancelled)),
        Err(Error::Cancelled)
    ));
}

/// AUTO on a photo whose sidecar asks for Auto analyses the as-shot render,
/// exactly as on an untouched photo: the request never resolves inside its
/// own analysis.
#[test]
fn auto_analysis_of_an_imported_auto_model_does_not_recurse() {
    let raw = raw();
    let imported = read_sidecar(r#"<x crs:WhiteBalance="Auto"/>"#);
    let compute = super::super::auto_adjustments::compute_auto_adjustments;
    assert_eq!(
        compute(&raw, &imported).unwrap(),
        compute(&raw, &AdjustmentModel::default()).unwrap()
    );
}

fn develop(raw: &RawImage, model: &AdjustmentModel, cap: Option<u32>) -> Vec<[f32; 3]> {
    match cap {
        None => {
            pipeline::develop_scene_linear_from_raw_with_quality(raw, model, RenderQuality::Amaze)
        }
        Some(edge) => pipeline::develop_scene_linear_sized_from_raw_with_quality(
            raw,
            model,
            RenderQuality::Amaze,
            edge,
        ),
    }
    .unwrap()
    .pixels
}

#[test]
fn session_first_frame_renders_as_shot_and_runs_no_analysis() {
    let raw = raw();
    let imported = read_sidecar(r#"<x crs:WhiteBalance="Auto" papp:AutoExposure="Off"/>"#);
    let as_shot = read_sidecar(r#"<x papp:AutoExposure="Off"/>"#);
    let mut first_frame = imported.clone();
    CachedEstimate::default().apply(&mut first_frame);
    assert!(!needs_resolution(&first_frame));
    assert!(!first_frame.temperature_seen && !first_frame.tint_seen);
    let mut resolved = imported.clone();
    let mut cache = CachedEstimate::default();
    cache.resolve(&raw, CancelToken::never()).unwrap();
    cache.apply(&mut resolved);
    for cap in [None, Some(16)] {
        let first = develop(&raw, &first_frame, cap);
        assert_eq!(first, develop(&raw, &as_shot, cap));
        assert_ne!(
            first,
            develop(&raw, &resolved, cap),
            "the re-render must change"
        );
    }
    let cancelled = std::sync::atomic::AtomicBool::new(true);
    assert!(matches!(
        CachedEstimate::default().resolve(&raw, CancelToken::new(&cancelled)),
        Err(Error::Cancelled)
    ));
}

#[test]
fn final_output_entries_resolve_name_only_auto_to_the_authored_equivalent() {
    let raw = raw();
    let imported = read_sidecar(r#"<x crs:WhiteBalance="Auto" papp:AutoExposure="Off"/>"#);
    let before = imported.clone();
    let pair = estimate(&raw, CancelToken::never()).unwrap();
    let explicit = read_sidecar(&format!(
        r#"<x crs:WhiteBalance="Auto" crs:Temperature="{}" crs:Tint="{}" papp:WbScaleVersion="5" papp:AutoExposure="Off"/>"#,
        pair.0, pair.1
    ));
    for cap in [None, Some(16)] {
        assert_eq!(develop(&raw, &imported, cap), develop(&raw, &explicit, cap));
    }
    let export = |model: &AdjustmentModel| {
        let options = crate::export::ExportOptions {
            format: crate::export::ExportFormat::Png,
            quality: 90,
            target: crate::view::encode::TargetPrimaries::Srgb,
            max_long_edge: Some(24),
        };
        crate::export::export_from_raw(&raw, model, None, &options)
            .unwrap()
            .bytes
    };
    assert_eq!(export(&imported), export(&explicit));
    assert_eq!(imported, before);
    let resolved = resolve(&raw, &imported, CancelToken::never()).unwrap();
    assert!(!needs_resolution(&resolved));
    assert!(matches!(
        resolve(&raw, &explicit, CancelToken::never()).unwrap(),
        Cow::Borrowed(_)
    ));
}

#[test]
fn resolved_estimate_is_the_shared_estimator_on_its_proxy_and_mutates_nothing() {
    let raw = raw();
    let original = read_sidecar(
        r#"<x crs:WhiteBalance="Auto" crs:Exposure2012="2" crs:Contrast2012="-60" crs:Dehaze="25"/>"#,
    );
    let before = original.clone();
    let probe_model = super::super::auto_adjustments::probe_model(&AdjustmentModel::default());
    let probe = pipeline::develop_scene_linear_sized_from_raw_with_quality(
        &raw,
        &probe_model,
        RenderQuality::Preview,
        PROBE_LONG_EDGE,
    )
    .unwrap();
    let expected = super::super::auto_adjustments_awb::compute_awb(&probe, &raw, &probe_model);
    let mut cache = CachedEstimate::default();
    assert_eq!(cache.resolve(&raw, CancelToken::never()).unwrap(), expected);
    assert_eq!(original, before);
    let mut render_model = original.clone();
    cache.apply(&mut render_model);
    assert_eq!((render_model.temperature, render_model.tint), expected);
    assert_eq!(
        (
            render_model.exposure,
            render_model.contrast,
            render_model.dehaze
        ),
        (2., -60., 25.)
    );
    assert_eq!(render_model.auto_exposure, AutoExposureMode::On);
    assert!(!needs_resolution(&render_model));
    assert_eq!(render_model.wb_scale_version, WbScaleVersion::V5);
}

#[test]
fn session_keeps_the_pair_so_later_requests_run_no_analysis() {
    let raw = raw();
    let original = read_sidecar(r#"<x crs:WhiteBalance="Auto"/>"#);
    let mut cache = CachedEstimate::default();
    let pair = cache.resolve(&raw, CancelToken::never()).unwrap();
    let cancelled = std::sync::atomic::AtomicBool::new(true);
    assert_eq!(
        cache.resolve(&raw, CancelToken::new(&cancelled)).unwrap(),
        pair
    );
    let mut next = AdjustmentModel {
        exposure: 2.,
        ..original
    };
    cache.apply(&mut next);
    assert_eq!(pair, (next.temperature, next.tint));
    assert_eq!(next.exposure, 2.);
}

#[test]
fn resolved_session_renders_equal_the_numerically_authored_pair() {
    let raw = raw();
    let imported = read_sidecar(r#"<x crs:WhiteBalance="Auto" papp:AutoExposure="Off"/>"#);
    let mut cache = CachedEstimate::default();
    let pair = cache.resolve(&raw, CancelToken::never()).unwrap();
    let mut resolved = imported.clone();
    cache.apply(&mut resolved);
    let explicit = read_sidecar(&format!(
        r#"<x crs:WhiteBalance="Auto" crs:Temperature="{}" crs:Tint="{}" papp:WbScaleVersion="5" papp:AutoExposure="Off"/>"#,
        pair.0, pair.1
    ));
    for cap in [None, Some(16)] {
        assert_eq!(develop(&raw, &resolved, cap), develop(&raw, &explicit, cap));
    }
    let tile = |model: &AdjustmentModel| {
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
    assert_eq!(tile(&resolved), tile(&explicit));
    // A final-output scene tile of the name-only sidecar resolves itself.
    assert_eq!(tile(&imported), tile(&explicit));
}

/// A mosaic on the fixture's calibration whose long edge exceeds the probe's,
/// so the full-resolution stages (linearize, demosaic, downsample) all run.
fn large_mosaic() -> RawImage {
    let raw = raw();
    let (width, height) = (1792, 1280);
    let (black, span) = (raw.black_level[0], raw.white_level - raw.black_level[0]);
    RawImage {
        width,
        height,
        raw_data: (0..width * height)
            .map(|i| (black + (i % width * 31 + i / width * 17) % span) as u16)
            .collect(),
        crop_rect: None,
        sensor_gain_maps: None,
        opcode_list3: None,
        lens_metadata: Default::default(),
        ..raw
    }
}

fn on_one_thread<R: Send>(run: impl FnOnce() -> R + Send) -> R {
    rayon::ThreadPoolBuilder::new()
        .num_threads(1)
        .build()
        .unwrap()
        .install(run)
}

#[test]
fn a_cancelled_estimate_starts_no_new_pass_after_the_cancel_and_a_later_ask_gets_the_same_pair() {
    on_one_thread(cancelled_estimate_starts_no_new_pass);
}

fn cancelled_estimate_starts_no_new_pass() {
    let raw = large_mosaic();
    let uncancelled = PollProbe::never_trips();
    let pair = estimate(&raw, uncancelled.token()).unwrap();
    let units = uncancelled.polls();
    assert!(
        units >= raw.height as usize,
        "the estimate polled {units} times, fewer than the {} rows of its first pass",
        raw.height
    );
    // The probe detects a pass that starts after the cancel from a call site
    // that had not polled yet; it cannot see a stage given
    // `CancelToken::never()`, a pass that polls once and ignores the answer,
    // or a later pass polling from the cancelled pass's own call site.
    // Linearize's row count below is the exact check.
    let trips = [0, units / 4]
        .into_iter()
        .chain(uncancelled.first_polls_of_distinct_sites(units.saturating_sub(8)));
    for trip_at in trips {
        let probe = PollProbe::trip_at(trip_at);
        let result = estimate(&raw, probe.token());
        assert!(
            matches!(result, Err(Error::Cancelled)),
            "a cancel at poll {trip_at} of {units} gave {result:?}"
        );
        let started_late = probe.later_polls_by_other_site();
        assert!(
            started_late.values().all(|polls| *polls == 1),
            "a cancel at poll {trip_at} of {units} let a pass start: {started_late:?}"
        );
    }
    let rows = raw.height as usize;
    let probe = PollProbe::trip_at(rows / 4);
    let linearized = crate::linearize::sensor_linearize_cancellable(&raw, probe.token());
    let rows_done = linearized
        .pixels
        .chunks(raw.width as usize)
        .filter(|row| row.iter().any(|px| px.iter().any(|v| *v != 0.)))
        .count();
    assert_eq!(
        rows_done,
        rows / 4,
        "linearize kept going after a cancel a quarter of the way in"
    );
    let unset = std::sync::atomic::AtomicBool::new(false);
    let retried = estimate(&raw, CancelToken::new(&unset)).unwrap();
    assert_eq!(
        (retried.0.to_bits(), retried.1.to_bits()),
        (pair.0.to_bits(), pair.1.to_bits())
    );
}
