//! The timing harness's real-run record and the worker behaviour its
//! cancellation probe depends on (#6043). Nothing here asserts a duration.
#[path = "../examples/perf-harness/completion.rs"]
mod completion;
#[path = "../examples/perf-harness/drive.rs"]
mod drive;
#[path = "../examples/perf-harness/record.rs"]
mod record;

use drive::{Options, Renderer};
use maple_linux::jobs::{Command, Event, Worker};
use maple_linux::library::Folder;
use raw_core::types::adjustment::{AdjustmentModel, Profile};
use sha2::{Digest, Sha256};
use std::path::{Path, PathBuf};
use std::time::Duration;

fn raw_fixture() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../../test-fixtures/batch-transfer/source.dng")
}

fn receive(worker: &Worker) -> Event {
    worker
        .events
        .recv_timeout(Duration::from_secs(120))
        .expect("the worker answers")
}

fn is_frame(event: &Event, generation: u64) -> bool {
    match event {
        Event::GpuRendered(2, published, _) | Event::Rendered(2, published, Ok(_), _) => {
            *published == generation
        }
        _ => false,
    }
}

/// The cancellation probe: a render for a closed image is answered with an
/// error, not a frame, once the worker is done with the render it superseded.
/// That render's frame may only come first (it finished before the probe was
/// sent), never after the answer.
fn closed_image_render_supersedes(gpu: Option<raw_gpu::GpuContext>) {
    let root = tempfile::tempdir().unwrap();
    std::fs::copy(raw_fixture(), root.path().join("source.dng")).unwrap();
    let photo = Folder::scan(root.path()).unwrap().photos.remove(0);
    let mut worker = Worker::with_gpu(eframe::egui::Context::default(), gpu);
    worker.send(Command::Open(2, photo));
    let model = match receive(&worker) {
        Event::Opened(2, Ok((document, _))) => document.model.clone(),
        _ => panic!("RAW open failed"),
    };
    worker.send(Command::Render(2, 1, model.clone()));
    assert!(is_frame(&receive(&worker), 1));
    let switched = AdjustmentModel {
        profile: Profile::Neutral,
        ..model.clone()
    };
    worker.send(Command::Render(2, 2, switched.clone()));
    worker.send(Command::Render(1, 3, switched));
    let answer = match receive(&worker) {
        finished if is_frame(&finished, 2) => receive(&worker),
        answer => answer,
    };
    assert!(
        matches!(answer, Event::Rendered(1, 3, Err(_), _)),
        "a closed image's render is answered with an error and no frame"
    );
    worker.send(Command::Render(2, 4, model));
    assert!(
        is_frame(&receive(&worker), 4),
        "nothing of the superseded switch follows the answer, and the open image still renders"
    );
    worker.finish();
}

#[test]
fn a_render_for_a_closed_image_supersedes_the_cpu_render_without_a_frame() {
    closed_image_render_supersedes(None);
}

#[test]
fn a_render_for_a_closed_image_supersedes_the_resident_gpu_render_without_a_frame() {
    closed_image_render_supersedes(Some(raw_gpu::GpuContext::new_blocking().unwrap()));
}

fn keys(value: &serde_json::Value) -> Vec<&str> {
    value
        .as_object()
        .expect("a JSON object")
        .keys()
        .map(String::as_str)
        .collect()
}

#[test]
fn the_harness_records_both_render_paths_of_a_real_raw_without_claiming_timing_it_cannot() {
    let source = raw_fixture();
    let bytes = std::fs::read(&source).unwrap();
    let options = Options {
        ticks: 6,
        cancellations: 2,
    };
    let row = record::measure(&source, options).unwrap();

    assert_eq!(row.gpu_resident.renderer, Renderer::GpuResident);
    assert_eq!(row.gpu_resident.fallback_reason, None);
    assert_eq!(row.cpu_fallback.renderer, Renderer::Cpu);
    for path in [&row.gpu_resident, &row.cpu_fallback] {
        assert_eq!(path.profile, "auto");
        assert!(path.native.0 > 0 && path.native.1 > 0);
        assert!(path.viewport_width > 0 && path.viewport_height > 0);
        assert!(path.cold_open_uncached_ms >= path.cold_open_decode_ms);
        assert!(path.cold_open_uncached_ms >= path.cold_open_submitted_ms);
        for ticks in [path.tick_exposure, path.tick_contrast] {
            assert_eq!(ticks.sent, 6);
            assert!((1..=6).contains(&ticks.published));
            assert!(ticks.first_tick_ms > 0.0 && ticks.worst_gap_ms >= ticks.first_tick_ms);
            if let (Some(finished), Some(submitted)) = (ticks.latency, ticks.submitted_ms) {
                assert!(finished.max_ms >= submitted.max_ms, "{ticks:?}");
            }
            assert_eq!(ticks.published_ratio, f64::from(ticks.published) / 6.0);
        }
        let cancellation = path.profile_switch_cancellation;
        assert_eq!(cancellation.samples, 2);
        assert_eq!(
            cancellation.latency.is_some(),
            cancellation.completed_before_cancel < 2
        );
        assert!(path.peak_resident_bytes > 0);
    }
    assert!(row.cpu_fallback.peak_resident_bytes >= row.gpu_resident.peak_resident_bytes);

    assert_eq!(row.fixture, "source.dng");
    let digest: String = Sha256::digest(&bytes)
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect();
    assert_eq!(row.fixture_sha256, digest);
    assert_eq!(
        row.timing_qualifies,
        row.timing_disqualifiers.is_empty(),
        "a row qualifies exactly when nothing disqualifies it"
    );
    assert!(
        !row.reference_fixture,
        "source.dng is not the reference RAW"
    );
    assert!(!row.timing_qualifies, "a small test RAW never qualifies");
    if row.adapter.software_adapter || cfg!(debug_assertions) || !cfg!(target_os = "linux") {
        assert!(!row.timing_qualifies, "{:?}", row.timing_disqualifiers);
    }
    assert_eq!(std::fs::read(&source).unwrap(), bytes);
    assert!(
        !source.with_extension("xmp").exists(),
        "the measured copy is private; nothing is written beside the original"
    );

    let folder = tempfile::tempdir().unwrap();
    let out = folder.path().join("linux/row.json");
    record::write(&row, &out).unwrap();
    let rows: serde_json::Value =
        serde_json::from_str(&std::fs::read_to_string(&out).unwrap()).unwrap();
    let written = &rows.as_array().expect("one row in an array")[0];
    assert_eq!(rows.as_array().unwrap().len(), 1);
    let path_keys = [
        "coldOpenDecodeMs",
        "coldOpenSubmittedMs",
        "coldOpenUncachedMs",
        "peakResidentBytes",
        "profile",
        "profileSwitchCancellation",
        "renderer",
        "tickContrast",
        "tickExposure",
        "viewportHeight",
        "viewportWidth",
    ];
    let row_keys = [
        "buildProfile",
        "cacheState",
        "chip",
        "commitSha",
        "coverage",
        "cpuFallback",
        "date",
        "deviceId",
        "deviceModel",
        "dirtyTree",
        "excludes",
        "fixture",
        "fixtureSha256",
        "gpu",
        "gpuBackend",
        "gpuDeviceType",
        "gpuDriver",
        "harness",
        "osVersion",
        "platform",
        "referenceFixture",
        "sensorHeight",
        "sensorMegapixels",
        "sensorWidth",
        "sessionType",
        "softwareAdapter",
        "tickRateHz",
        "ticksPerSlider",
        "timingDisqualifiers",
        "timingQualifies",
    ];
    let mut expected: Vec<&str> = path_keys.iter().chain(&row_keys).copied().collect();
    expected.sort_unstable();
    let mut top_level = keys(written);
    top_level.sort_unstable();
    assert_eq!(top_level, expected);
    let mut fallback = keys(&written["cpuFallback"]);
    fallback.sort_unstable();
    assert_eq!(fallback, path_keys);
    let mut ticks = keys(&written["tickExposure"]);
    ticks.sort_unstable();
    assert_eq!(
        ticks,
        [
            "firstTickMs",
            "maxMs",
            "over16",
            "over50",
            "p50Ms",
            "p95Ms",
            "published",
            "publishedRatio",
            "sent",
            "submittedMs",
            "worstGapMs"
        ]
    );
    assert_eq!(written["platform"], std::env::consts::OS);
    assert_eq!(written["renderer"], "gpu-resident");
    assert_eq!(written["cpuFallback"]["renderer"], "cpu");
    assert_eq!(written["tickRateHz"], 60);
    assert_eq!(written["ticksPerSlider"], 6);
    assert_eq!(written["timingQualifies"], row.timing_qualifies);
    for key in ["switchUninterruptedMs", "samples", "completedBeforeCancel"] {
        assert!(
            written["profileSwitchCancellation"][key].is_number(),
            "{key}"
        );
    }
    assert!(written["sensorMegapixels"].as_f64().unwrap() > 0.0);
    assert_eq!(written["referenceFixture"], false);
    assert!(written["dirtyTree"].is_boolean() || written["dirtyTree"].is_null());
    let excluded: Vec<&str> = written["excludes"]
        .as_array()
        .unwrap()
        .iter()
        .filter_map(|item| item.as_str())
        .collect();
    for needed in [
        "quiet-refine",
        "frame presentation",
        "saves on the worker",
        "upper bound",
    ] {
        assert!(
            excluded.iter().any(|item| item.contains(needed)),
            "{needed}"
        );
    }
    assert!(written["coverage"].as_array().unwrap().len() >= 4);
}
