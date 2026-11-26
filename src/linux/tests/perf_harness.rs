//! The timing harness's record, and the worker behaviour its cancellation
//! probe depends on (#6043). Nothing here asserts a duration.
#[path = "../examples/perf-harness/drive.rs"]
mod drive;
#[path = "../examples/perf-harness/record.rs"]
mod record;

use drive::{
    Options, PathMeasurement, Percentiles, ProfileSwitchCancellation, Renderer, TickStats,
};
use eframe::egui_wgpu::wgpu;
use maple_linux::jobs::{Command, Event, Worker};
use maple_linux::library::Folder;
use raw_core::types::adjustment::{AdjustmentModel, Profile};
use record::Adapter;
use sha2::{Digest, Sha256};
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

fn raw_fixture() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../../test-fixtures/batch-transfer/source.dng")
}

fn adapter(device_type: wgpu::DeviceType, backend: wgpu::Backend) -> Adapter {
    Adapter::from_info(&wgpu::AdapterInfo {
        name: "Example adapter".into(),
        vendor: 0,
        device: 0,
        device_type,
        driver: "example".into(),
        driver_info: "1.2.3".into(),
        backend,
    })
}

#[test]
fn percentiles_are_nearest_rank_and_absent_without_samples() {
    assert_eq!(Percentiles::of(&[]), None);
    let samples: Vec<f64> = (1..=20).rev().map(f64::from).collect();
    assert_eq!(
        Percentiles::of(&samples),
        Some(Percentiles {
            p50_ms: 10.0,
            p95_ms: 19.0,
            max_ms: 20.0,
        })
    );
    assert_eq!(
        Percentiles::of(&[7.5]),
        Some(Percentiles {
            p50_ms: 7.5,
            p95_ms: 7.5,
            max_ms: 7.5,
        })
    );
}

fn timeline(sent: u32, frames: &[(usize, u64)]) -> TickStats {
    let origin = Instant::now();
    let at = |millis: u64| origin + Duration::from_millis(millis);
    let sent: Vec<Instant> = (0..sent).map(|tick| at(u64::from(tick) * 10)).collect();
    let frames: Vec<(usize, Instant)> = frames.iter().map(|&(tick, ms)| (tick, at(ms))).collect();
    TickStats::from_timeline(&sent, &frames).unwrap()
}

#[test]
fn tick_statistics_separate_the_first_frame_and_measure_the_longest_gap() {
    let stats = timeline(6, &[(0, 30), (1, 40), (2, 56), (4, 160), (5, 170)]);
    assert_eq!(stats.first_tick_ms, 30.0);
    assert_eq!((stats.sent, stats.published), (6, 5));
    assert_eq!((stats.over16, stats.over50), (4, 2));
    assert_eq!(stats.published_ratio, 5.0 / 6.0);
    let latency = stats.latency.unwrap();
    assert_eq!((latency.p50_ms, latency.max_ms), (36.0, 120.0));
    assert_eq!(
        stats.worst_gap_ms, 104.0,
        "the longest interval between the drag start, each frame and the last frame"
    );
    let only_first = timeline(3, &[(2, 40)]);
    assert_eq!((only_first.latency, only_first.first_tick_ms), (None, 20.0));
    assert!(TickStats::from_timeline(&[Instant::now()], &[]).is_none());
}

#[test]
fn a_drag_is_starved_below_twenty_frames_or_half_the_ticks() {
    let frames = |count: usize| -> Vec<(usize, u64)> {
        (0..count)
            .map(|tick| (tick, tick as u64 * 10 + 5))
            .collect()
    };
    assert!(timeline(120, &frames(19)).starved());
    assert!(!timeline(40, &frames(20)).starved());
    assert!(timeline(120, &frames(59)).starved());
    assert!(!timeline(120, &frames(60)).starved());
}

#[test]
fn a_closed_channel_is_the_worker_exiting_and_zero_ticks_fail_at_once() {
    let (sender, receiver) = std::sync::mpsc::channel::<()>();
    assert_eq!(
        drive::lost(receiver.recv_timeout(Duration::ZERO).unwrap_err()),
        "The worker published nothing for ten minutes"
    );
    drop(sender);
    assert_eq!(
        drive::lost(receiver.recv_timeout(Duration::ZERO).unwrap_err()),
        "The worker exited"
    );
    assert!(Options {
        ticks: 0,
        cancellations: 1
    }
    .check()
    .is_err());
    assert!(Options::default().check().is_ok());
}

fn path(renderer: Renderer, published: usize) -> PathMeasurement {
    let ticks = timeline(
        100,
        &(0..published)
            .map(|tick| (tick, tick as u64 * 10 + 5))
            .collect::<Vec<_>>(),
    );
    PathMeasurement {
        renderer,
        fallback_reason: None,
        profile: "auto",
        viewport_width: 1,
        viewport_height: 1,
        cold_open_uncached_ms: 1.0,
        cold_open_decode_ms: 1.0,
        tick_exposure: ticks,
        tick_contrast: ticks,
        profile_switch_cancellation: ProfileSwitchCancellation {
            switch_uninterrupted_ms: 1.0,
            samples: 1,
            completed_before_cancel: 1,
            latency: None,
        },
        peak_resident_bytes: 1,
        native: (12_288, 8_192),
    }
}

#[test]
fn a_row_qualifies_only_for_the_reference_raw_on_a_clean_release_build_on_linux_gpu_hardware() {
    let hardware = adapter(wgpu::DeviceType::DiscreteGpu, wgpu::Backend::Vulkan);
    let integrated = adapter(wgpu::DeviceType::IntegratedGpu, wgpu::Backend::Vulkan);
    let software = adapter(wgpu::DeviceType::Cpu, wgpu::Backend::Vulkan);
    assert_eq!(hardware.gpu_driver, "example 1.2.3");
    assert!(!hardware.software_adapter && software.software_adapter);
    for name in [
        "llvmpipe (LLVM 17.0.6, 256 bits)",
        "SwiftShader Device",
        "Lavapipe",
    ] {
        let info = wgpu::AdapterInfo {
            name: name.into(),
            vendor: 0,
            device: 0,
            device_type: wgpu::DeviceType::VirtualGpu,
            driver: String::new(),
            driver_info: String::new(),
            backend: wgpu::Backend::Vulkan,
        };
        assert!(Adapter::from_info(&info).software_adapter, "{name}");
    }
    let named = wgpu::AdapterInfo {
        name: "Example Software Defined Graphics".into(),
        vendor: 0,
        device: 0,
        device_type: wgpu::DeviceType::DiscreteGpu,
        driver: "example".into(),
        driver_info: String::new(),
        backend: wgpu::Backend::Vulkan,
    };
    assert!(!Adapter::from_info(&named).software_adapter);

    let gpu = path(Renderer::GpuResident, 100);
    let reasons =
        |os: &str, profile: &str, adapter: &Adapter, path: &PathMeasurement, sha: &str, tree| {
            record::disqualifiers(&record::Conditions {
                os,
                build_profile: profile,
                adapter,
                gpu_path: path,
                fixture_sha256: sha,
                dirty_tree: tree,
            })
        };
    let reference = record::REFERENCE_SHA256;
    let clean = Some(false);
    assert!(reasons("linux", "release", &hardware, &gpu, reference, clean).is_empty());
    assert!(reasons("linux", "release", &integrated, &gpu, reference, clean).is_empty());
    assert_eq!(
        reasons("linux", "release", &software, &gpu, reference, clean),
        ["software adapter: a CPU rasterizer is not GPU evidence"]
    );
    assert_eq!(
        reasons("linux", "debug", &hardware, &gpu, reference, clean),
        ["debug build"]
    );
    assert_eq!(
        reasons("macos", "release", &hardware, &gpu, reference, clean),
        ["the host is macos, not Linux"]
    );
    assert_eq!(
        reasons(
            "linux",
            "release",
            &hardware,
            &path(Renderer::Cpu, 100),
            reference,
            clean
        ),
        ["the GPU path fell back to CPU rendering"]
    );
    assert_eq!(
        reasons(
            "linux",
            "release",
            &adapter(wgpu::DeviceType::IntegratedGpu, wgpu::Backend::Gl),
            &gpu,
            reference,
            clean
        ),
        ["Gl backend, not Vulkan"]
    );
    for other in [wgpu::DeviceType::VirtualGpu, wgpu::DeviceType::Other] {
        assert_eq!(
            reasons(
                "linux",
                "release",
                &adapter(other, wgpu::Backend::Vulkan),
                &gpu,
                reference,
                clean
            ),
            [format!("{other:?} is not a discrete or integrated GPU")]
        );
    }
    assert_eq!(
        reasons(
            "linux",
            "release",
            &hardware,
            &path(Renderer::GpuResident, 19),
            reference,
            clean
        ),
        [
            "the Exposure drag published 19 of 100 frames, too few for percentiles",
            "the Contrast drag published 19 of 100 frames, too few for percentiles"
        ]
    );
    assert_eq!(
        reasons("linux", "release", &hardware, &gpu, "0000", clean),
        ["the RAW is not the reference dji-mavic3pro-100mp.dng"]
    );
    assert_eq!(
        reasons("linux", "release", &hardware, &gpu, reference, Some(true)),
        ["the working tree has uncommitted changes"]
    );
    assert_eq!(
        reasons("linux", "release", &hardware, &gpu, reference, None),
        ["the working tree could not be inspected"]
    );
}

#[test]
fn the_reference_hash_is_the_one_the_100mp_qualification_record_commits() {
    let record: serde_json::Value = serde_json::from_str(
        &std::fs::read_to_string(
            Path::new(env!("CARGO_MANIFEST_DIR"))
                .join("../../test-fixtures/qualification/browser-100mp-3669.json"),
        )
        .unwrap(),
    )
    .unwrap();
    assert_eq!(record["fixture"], "dji-mavic3pro-100mp.dng");
    assert_eq!(record["sha256"], record::REFERENCE_SHA256);
}

#[test]
fn host_identity_parses_system_files_and_formats_the_record_date() {
    let cpuinfo = "processor\t: 0\nmodel name\t: Example CPU 9000 8-Core\nflags\t: fpu\n";
    assert_eq!(record::cpu_model(cpuinfo), Some("Example CPU 9000 8-Core"));
    assert_eq!(record::cpu_model("processor\t: 0\n"), None);
    let os_release = "NAME=\"Example\"\nPRETTY_NAME=\"Example Linux 1.0 LTS\"\n";
    assert_eq!(record::os_name(os_release), Some("Example Linux 1.0 LTS"));
    assert_eq!(record::os_name("ID=example\n"), None);
    assert_eq!(
        record::device_id("Example Co. Laptop 16 (Gen 2)", "Example GPU/4000"),
        "Example-Co-Laptop-16-Gen-2-Example-GPU-4000"
    );
    assert_eq!(record::iso8601_utc(0), "1970-01-01T00:00:00Z");
    assert_eq!(record::iso8601_utc(951_782_400), "2000-02-29T00:00:00Z");
    assert_eq!(record::iso8601_utc(1_700_000_000), "2023-11-14T22:13:20Z");
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
        for ticks in [path.tick_exposure, path.tick_contrast] {
            assert_eq!(ticks.sent, 6);
            assert!((1..=6).contains(&ticks.published));
            assert!(ticks.first_tick_ms > 0.0 && ticks.worst_gap_ms >= ticks.first_tick_ms);
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
    for needed in ["quiet-refine", "frame presentation", "saves on the worker"] {
        assert!(
            excluded.iter().any(|item| item.contains(needed)),
            "{needed}"
        );
    }
    assert!(written["coverage"].as_array().unwrap().len() >= 4);
}
