//! The `test-fixtures/perf/linux/` row the timing harness writes (#6043). The
//! top-level timings are the resident GPU path, under the keys the Apple row
//! and `tools/perf-table.py` already use; `cpuFallback` repeats them for the
//! CPU renderer. A row that is not hardware evidence says so itself.
use crate::drive::{self, Options, PathMeasurement, Renderer, TickStats, TICK_RATE_HZ};
use eframe::egui_wgpu::wgpu;
use maple_linux::diagnose;
use maple_linux::library::{Folder, MediaKind};
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::path::Path;
use std::time::{SystemTime, UNIX_EPOCH};

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Adapter {
    #[serde(skip)]
    pub device_type: wgpu::DeviceType,
    pub gpu: String,
    pub gpu_driver: String,
    pub gpu_backend: String,
    pub gpu_device_type: String,
    pub software_adapter: bool,
}

impl Adapter {
    pub fn from_info(info: &wgpu::AdapterInfo) -> Self {
        Self {
            device_type: info.device_type,
            gpu: info.name.clone(),
            gpu_driver: format!("{} {}", info.driver, info.driver_info)
                .trim()
                .to_owned(),
            gpu_backend: format!("{:?}", info.backend),
            gpu_device_type: format!("{:?}", info.device_type),
            software_adapter: is_software(info),
        }
    }
}

/// Some software rasterizers report a virtual or other device type, so the
/// well-known rasterizer identifiers count as well as the CPU device type.
fn is_software(info: &wgpu::AdapterInfo) -> bool {
    let identity = format!("{} {}", info.name, info.driver).to_ascii_lowercase();
    info.device_type == wgpu::DeviceType::Cpu
        || ["llvmpipe", "lavapipe", "swiftshader", "softpipe"]
            .iter()
            .any(|rasterizer| identity.contains(rasterizer))
}

/// The RAW the Apple rows and `test-fixtures/qualification/browser-100mp-3669.json`
/// record by this hash; a timing row is only comparable on this file.
pub const REFERENCE_SHA256: &str =
    "f4b60b3672bdf7ff7f4376fba9da1b1d22c925ebc3e16baa5fd4a64fa1045aa5";

pub const COVERAGE: &[&str] = &[
    "worker open to first frame finished on the GPU",
    "tick-to-finished-frame latency of an Exposure and a Contrast drag at 60 Hz",
    "the same latency stopped at the worker's submission event (submittedMs)",
    "ticks answered and the longest stretch without a finished frame",
    "time to abandon a profile switch superseded by a render for a closed session",
    "process peak resident memory",
];

pub const EXCLUDES: &[&str] = &[
    "the debounced quiet-refine and detail pass",
    "frame presentation after the worker event",
    "saves on the worker thread",
    "input dispatch and the egui frame loop",
    "GPU memory",
    "cancellation of a slider tick superseded by the next tick",
    "exact per-frame GPU completion: the work-done callback covers every submission made before it, so finished-frame latency is an upper bound",
];

/// What a run is measured on; `disqualifiers` turns it into reasons.
pub struct Conditions<'a> {
    pub os: &'a str,
    pub build_profile: &'a str,
    pub adapter: &'a Adapter,
    pub gpu_path: &'a PathMeasurement,
    pub fixture_sha256: &'a str,
    pub dirty_tree: Option<bool>,
}

/// Why a run is not a timing measurement of Linux GPU hardware; empty when it is.
pub fn disqualifiers(conditions: &Conditions) -> Vec<String> {
    let Conditions {
        os,
        build_profile,
        adapter,
        gpu_path,
        fixture_sha256,
        dirty_tree,
    } = conditions;
    let hardware_type = matches!(
        adapter.device_type,
        wgpu::DeviceType::DiscreteGpu | wgpu::DeviceType::IntegratedGpu
    );
    let starved = |control: &str, ticks: &TickStats| {
        ticks.starved().then(|| {
            format!(
                "the {control} drag published {} of {} frames, too few for percentiles",
                ticks.published, ticks.sent
            )
        })
    };
    [
        (*os != "linux").then(|| format!("the host is {os}, not Linux")),
        (*build_profile != "release").then(|| format!("{build_profile} build")),
        adapter
            .software_adapter
            .then(|| "software adapter: a CPU rasterizer is not GPU evidence".to_owned()),
        (!hardware_type && !adapter.software_adapter).then(|| {
            format!(
                "{} is not a discrete or integrated GPU",
                adapter.gpu_device_type
            )
        }),
        (*os == "linux" && adapter.gpu_backend != "Vulkan")
            .then(|| format!("{} backend, not Vulkan", adapter.gpu_backend)),
        (gpu_path.renderer != Renderer::GpuResident)
            .then(|| "the GPU path fell back to CPU rendering".to_owned()),
        starved("Exposure", &gpu_path.tick_exposure),
        starved("Contrast", &gpu_path.tick_contrast),
        (*fixture_sha256 != REFERENCE_SHA256)
            .then(|| "the RAW is not the reference dji-mavic3pro-100mp.dng".to_owned()),
        (*dirty_tree != Some(false)).then(|| {
            match dirty_tree {
                Some(_) => "the working tree has uncommitted changes",
                None => "the working tree could not be inspected",
            }
            .to_owned()
        }),
    ]
    .into_iter()
    .flatten()
    .collect()
}

pub fn cpu_model(cpuinfo: &str) -> Option<&str> {
    cpuinfo
        .lines()
        .find_map(|line| line.strip_prefix("model name"))
        .and_then(|rest| rest.split_once(':'))
        .map(|(_, name)| name.trim())
}

pub fn os_name(os_release: &str) -> Option<&str> {
    os_release
        .lines()
        .find_map(|line| line.strip_prefix("PRETTY_NAME="))
        .map(|name| name.trim_matches('"'))
}

/// A file-name-safe identity for `test-fixtures/perf/linux/<device-id>.json`.
pub fn device_id(model: &str, gpu: &str) -> String {
    let words: Vec<&str> = [model, gpu]
        .into_iter()
        .flat_map(|text| text.split(|letter: char| !letter.is_ascii_alphanumeric()))
        .filter(|word| !word.is_empty())
        .collect();
    words.join("-")
}

/// `seconds` since the Unix epoch as an ISO 8601 UTC timestamp.
pub fn iso8601_utc(seconds: u64) -> String {
    let (days, clock) = (seconds / 86_400, seconds % 86_400);
    let shifted = days + 719_468;
    let (era, day_of_era) = (shifted / 146_097, shifted % 146_097);
    let year_of_era =
        (day_of_era - day_of_era / 1_460 + day_of_era / 36_524 - day_of_era / 146_096) / 365;
    let day_of_year = day_of_era - (365 * year_of_era + year_of_era / 4 - year_of_era / 100);
    let shifted_month = (5 * day_of_year + 2) / 153;
    let day = day_of_year - (153 * shifted_month + 2) / 5 + 1;
    let month = if shifted_month < 10 {
        shifted_month + 3
    } else {
        shifted_month - 9
    };
    let year = year_of_era + era * 400 + u64::from(month <= 2);
    format!(
        "{year:04}-{month:02}-{day:02}T{:02}:{:02}:{:02}Z",
        clock / 3_600,
        clock % 3_600 / 60,
        clock % 60
    )
}

pub fn sha256(path: &Path) -> Result<String, String> {
    let mut file = std::fs::File::open(path).map_err(|error| error.to_string())?;
    let mut hasher = Sha256::new();
    std::io::copy(&mut file, &mut hasher).map_err(|error| error.to_string())?;
    Ok(hasher
        .finalize()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect())
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Host {
    pub device_id: String,
    pub device_model: String,
    pub chip: String,
    pub os_version: String,
    pub session_type: &'static str,
}

impl Host {
    pub fn probe(gpu: &str) -> Self {
        let read = |path: &str| std::fs::read_to_string(path).unwrap_or_default();
        let known = |text: &str| match text.trim() {
            "" => "unknown".to_owned(),
            text => text.to_owned(),
        };
        let device_model = known(&format!(
            "{} {}",
            read("/sys/class/dmi/id/sys_vendor").trim(),
            read("/sys/class/dmi/id/product_name").trim()
        ));
        let (session, _) = diagnose::session(std::env::var_os, |socket| {
            std::os::unix::net::UnixStream::connect(socket).is_ok()
        });
        Self {
            device_id: device_id(&device_model, gpu),
            chip: known(cpu_model(&read("/proc/cpuinfo")).unwrap_or_default()),
            os_version: known(os_name(&read("/etc/os-release")).unwrap_or_default()),
            session_type: match session {
                diagnose::Session::Wayland => "wayland",
                diagnose::Session::X11 => "x11",
                diagnose::Session::None => "none",
            },
            device_model,
        }
    }
}

fn git(arguments: &[&str]) -> Option<String> {
    std::process::Command::new("git")
        .args(arguments)
        .current_dir(env!("CARGO_MANIFEST_DIR"))
        .output()
        .ok()
        .filter(|output| output.status.success())
        .map(|output| String::from_utf8_lossy(&output.stdout).trim().to_owned())
}

fn commit_sha() -> String {
    git(&["rev-parse", "HEAD"])
        .filter(|sha| !sha.is_empty())
        .unwrap_or_else(|| "unknown".to_owned())
}

fn dirty_tree() -> Option<bool> {
    git(&["status", "--porcelain"]).map(|changes| !changes.is_empty())
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Record {
    pub platform: &'static str,
    pub harness: &'static str,
    pub commit_sha: String,
    pub dirty_tree: Option<bool>,
    pub date: String,
    #[serde(flatten)]
    pub host: Host,
    #[serde(flatten)]
    pub adapter: Adapter,
    pub build_profile: &'static str,
    pub timing_qualifies: bool,
    pub timing_disqualifiers: Vec<String>,
    pub fixture: String,
    pub fixture_sha256: String,
    pub reference_fixture: bool,
    pub sensor_width: u32,
    pub sensor_height: u32,
    pub sensor_megapixels: f64,
    pub coverage: &'static [&'static str],
    pub excludes: &'static [&'static str],
    pub cache_state: &'static str,
    pub tick_rate_hz: u32,
    pub ticks_per_slider: u32,
    #[serde(flatten)]
    pub gpu_resident: PathMeasurement,
    pub cpu_fallback: PathMeasurement,
}

/// Measures both render paths on a private copy of `raw`, so no sidecar beside
/// the original is read or written. The resident GPU path runs first.
pub fn measure(raw: &Path, options: Options) -> Result<Record, String> {
    let fixture = raw
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or("The RAW path has no file name")?
        .to_owned();
    let fixture_sha256 = sha256(raw)?;
    let staged = tempfile::tempdir().map_err(|error| error.to_string())?;
    std::fs::copy(raw, staged.path().join(&fixture)).map_err(|error| error.to_string())?;
    let photo = Folder::scan(staged.path())
        .map_err(|error| error.to_string())?
        .photos
        .pop()
        .filter(|photo| photo.kind == MediaKind::Raw)
        .ok_or_else(|| format!("{fixture} is not a RAW photograph the application opens"))?;
    let gpu = raw_gpu::GpuContext::new_blocking()?;
    let adapter = Adapter::from_info(&gpu.adapter.get_info());
    let gpu_resident = drive::measure_path(photo.clone(), Some(gpu), options)?;
    let cpu_fallback = drive::measure_path(photo, None, options)?;
    let build_profile = if cfg!(debug_assertions) {
        "debug"
    } else {
        "release"
    };
    let dirty_tree = dirty_tree();
    let timing_disqualifiers = disqualifiers(&Conditions {
        os: std::env::consts::OS,
        build_profile,
        adapter: &adapter,
        gpu_path: &gpu_resident,
        fixture_sha256: &fixture_sha256,
        dirty_tree,
    });
    let (sensor_width, sensor_height) = gpu_resident.native;
    let recorded = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |since| since.as_secs());
    Ok(Record {
        platform: std::env::consts::OS,
        harness: "perf-harness",
        commit_sha: commit_sha(),
        dirty_tree,
        date: iso8601_utc(recorded),
        host: Host::probe(&adapter.gpu),
        adapter,
        build_profile,
        timing_qualifies: timing_disqualifiers.is_empty(),
        timing_disqualifiers,
        fixture,
        reference_fixture: fixture_sha256 == REFERENCE_SHA256,
        fixture_sha256,
        sensor_width,
        sensor_height,
        sensor_megapixels: f64::from(sensor_width) * f64::from(sensor_height) / 1e6,
        coverage: COVERAGE,
        excludes: EXCLUDES,
        cache_state: "uncachedOpen",
        tick_rate_hz: TICK_RATE_HZ,
        ticks_per_slider: options.ticks,
        gpu_resident,
        cpu_fallback,
    })
}

/// Writes the one-row array `tools/perf-table.py` reads.
pub fn write(record: &Record, out: &Path) -> Result<(), String> {
    let rows = serde_json::to_string_pretty(&[record]).map_err(|error| error.to_string())?;
    if let Some(folder) = out.parent() {
        std::fs::create_dir_all(folder).map_err(|error| error.to_string())?;
    }
    std::fs::write(out, rows + "\n").map_err(|error| error.to_string())
}
