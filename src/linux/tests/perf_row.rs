//! The timing harness's record rules: percentiles, the drag statistics, GPU
//! completion, and when a row qualifies as timing evidence (#6043). Nothing here
//! asserts a duration.
//!
//! This crate includes the harness modules whole, as the example does, so the
//! items only the worker tests (`perf_harness.rs`) use are unused here.
#![allow(dead_code)]
#[path = "../examples/perf-harness/completion.rs"]
mod completion;
#[path = "../examples/perf-harness/drive.rs"]
mod drive;
#[path = "../examples/perf-harness/record.rs"]
mod record;

use drive::{
    Frame, Options, PathMeasurement, Percentiles, ProfileSwitchCancellation, Renderer, TickStats,
};
use eframe::egui_wgpu::wgpu;
use record::Adapter;
use std::path::Path;
use std::time::{Duration, Instant};

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

fn finished(sent: u32, frames: &[(usize, u64, u64)]) -> TickStats {
    let origin = Instant::now();
    let at = |millis: u64| origin + Duration::from_millis(millis);
    let sent: Vec<Instant> = (0..sent).map(|tick| at(u64::from(tick) * 10)).collect();
    let frames: Vec<Frame> = frames
        .iter()
        .map(|&(tick, submitted, completed)| Frame {
            tick,
            submitted: at(submitted),
            completed: at(completed),
        })
        .collect();
    TickStats::from_timeline(&sent, &frames).unwrap()
}

fn timeline(sent: u32, frames: &[(usize, u64)]) -> TickStats {
    let same: Vec<(usize, u64, u64)> = frames.iter().map(|&(tick, ms)| (tick, ms, ms)).collect();
    finished(sent, &same)
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
fn tick_latency_stops_at_gpu_completion_and_submission_is_recorded_beside_it() {
    let stats = finished(4, &[(0, 12, 70), (1, 22, 90), (2, 32, 130), (3, 42, 250)]);
    let completed = stats.latency.unwrap();
    let submitted = stats.submitted_ms.unwrap();
    assert_eq!((completed.p50_ms, completed.max_ms), (110.0, 220.0));
    assert_eq!((submitted.p50_ms, submitted.max_ms), (12.0, 12.0));
    assert_eq!(stats.first_tick_ms, 70.0);
    assert_eq!(
        (stats.over16, stats.over50),
        (3, 3),
        "frames submitted in 12 ms but finished in 70 ms or more are not sub-16 ms frames"
    );
    assert_eq!(
        stats.worst_gap_ms, 120.0,
        "gaps between finished frames, not between submissions"
    );
}

#[test]
fn a_work_done_callback_reports_when_submitted_gpu_work_finished() {
    let ctx = raw_gpu::GpuContext::new_blocking().unwrap();
    let mut watch = completion::CompletionWatch::new(&ctx);
    assert_eq!(
        watch.completed(1, Duration::ZERO).unwrap(),
        None,
        "a frame the GPU never rendered is not waited for"
    );
    let before = Instant::now();
    ctx.queue.submit(std::iter::empty());
    watch.expect(1);
    let at = watch
        .completed(1, Duration::from_secs(60))
        .unwrap()
        .expect("an expected frame completes");
    assert!(at >= before);
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
        cold_open_submitted_ms: 1.0,
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
