//! The capture refine (#5381) on real bodies: the S0 GPU/CPU gate against a
//! fresh capture decode, and the refine's latency and peak memory at the Mac
//! and iPhone budgets (2560 px / 128 MiB and 1536 px / 32 MiB).
//!
//! Gate: `cargo test -p raw-ffi --release --features gpu,fixtures
//! capture_refine_physical`. Measurement (run alone, on an idle machine):
//! `cargo test -p raw-ffi --release --features gpu,fixtures
//! capture_refine_latency_and_memory -- --ignored --nocapture`.

use super::gpu_live_capture_refine_tests::{assert_s0, decode_with_base, refine};
use crate::capture_base::maple_free_capture_base;
use crate::capture_base::tests::{pixels, xmp};
use crate::capture_creative::maple_free_capture_buffer_f32;
use crate::gpu_live::capture_refine::MapleCaptureRefineBudget;
use std::ffi::CString;

const STAGES: [(&str, &str); 4] = [
    ("chroma", "papp:ChromaPrefilter=\"60\""),
    ("denoise", "papp:DeepDenoise=\"50\""),
    ("sharpening", "papp:CaptureSharpeningAmount=\"80\""),
    (
        "all",
        "papp:ChromaPrefilter=\"60\" papp:DeepDenoise=\"50\" papp:CaptureSharpeningAmount=\"80\"",
    ),
];

/// (long edge, BM3D binding cap) for the Mac and iPhone budgets of #5213.
const BUDGETS: [(u32, u32); 2] = [(2560, 128 << 20), (1536, 32 << 20)];

/// The budgets plus the macOS ceiling the host allows (a 4096 px refine).
const MEASURED: [(u32, u32); 3] = [(2560, 128 << 20), (4096, 128 << 20), (1536, 32 << 20)];

fn fixture(name: &str) -> CString {
    let path = raw_core::test_support::fixtures::require_raw(name);
    CString::new(path.to_str().unwrap()).unwrap()
}

fn budget((max_long_edge, bm3d_binding_cap_bytes): (u32, u32)) -> MapleCaptureRefineBudget {
    MapleCaptureRefineBudget {
        max_long_edge,
        bm3d_binding_cap_bytes,
    }
}

#[test]
#[cfg_attr(not(feature = "fixtures"), ignore)]
fn capture_refine_physical_parity() {
    let dir = tempfile::tempdir().unwrap();
    // test_0007 is the S0 scene, test_0005 an X-Trans body, and test_0013
    // carries EXIF orientation 6, so the refine runs in the sensor frame.
    for name in ["test_0007.DNG", "test_0005.RAF", "test_0013.DNG"] {
        let raw = fixture(name);
        for limits in BUDGETS {
            let (mut first, base) = decode_with_base(&raw, None, limits.0);
            for (label, body) in STAGES {
                let sidecar = xmp(&dir, &format!("{label}.xmp"), body);
                let (rc, mut refined) = refine(base, &sidecar, budget(limits), std::ptr::null());
                assert_eq!(rc, 0, "{name} {label} refine rc {rc}");
                let (mut fresh, fresh_base) = decode_with_base(&raw, Some(&sidecar), limits.0);
                assert_eq!(
                    (refined.scene.width, refined.scene.height),
                    (fresh.scene.width, fresh.scene.height)
                );
                assert_s0(
                    &format!("{name} {}px {label}", limits.0),
                    &pixels(&fresh),
                    &pixels(&refined),
                );
                let (a, b) = (refined.creative.ae_gain, fresh.creative.ae_gain);
                assert!((a - b).abs() <= 1e-4 * b, "{name} {label}: ae {a} vs {b}");
                unsafe {
                    maple_free_capture_buffer_f32(&mut refined);
                    maple_free_capture_buffer_f32(&mut fresh);
                    maple_free_capture_base(fresh_base);
                }
            }
            unsafe {
                maple_free_capture_buffer_f32(&mut first);
                maple_free_capture_base(base);
            }
        }
    }
}

/// The process's current physical footprint, the figure jetsam enforces.
#[cfg(target_vendor = "apple")]
fn phys_footprint() -> u64 {
    let mut info: libc::rusage_info_v4 = unsafe { std::mem::zeroed() };
    let rc = unsafe {
        libc::proc_pid_rusage(
            std::process::id() as i32,
            libc::RUSAGE_INFO_V4,
            (&mut info as *mut libc::rusage_info_v4).cast(),
        )
    };
    assert_eq!(rc, 0);
    info.ri_phys_footprint
}

/// Sample the footprint every millisecond while `work` runs; the peak.
#[cfg(target_vendor = "apple")]
fn peak_footprint<T>(work: impl FnOnce() -> T) -> (T, u64) {
    use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
    let done = AtomicBool::new(false);
    let peak = AtomicU64::new(phys_footprint());
    let result = std::thread::scope(|scope| {
        scope.spawn(|| {
            while !done.load(Ordering::Relaxed) {
                peak.fetch_max(phys_footprint(), Ordering::Relaxed);
                std::thread::sleep(std::time::Duration::from_millis(1));
            }
        });
        let result = work();
        done.store(true, Ordering::Relaxed);
        result
    });
    (result, peak.load(Ordering::Relaxed))
}

#[cfg(target_vendor = "apple")]
#[test]
#[ignore = "controlled-hardware refine measurement; run alone in release"]
fn capture_refine_latency_and_memory() {
    const MIB: f64 = 1024.0 * 1024.0;
    let dir = tempfile::tempdir().unwrap();
    let raw = fixture("test_0007.DNG");
    let all = xmp(&dir, "all.xmp", STAGES[3].1);
    let lighter = xmp(
        &dir,
        "lighter.xmp",
        "papp:ChromaPrefilter=\"40\" papp:DeepDenoise=\"30\" papp:CaptureSharpeningAmount=\"60\"",
    );
    for limits in MEASURED {
        let (mut first, base) = decode_with_base(&raw, None, limits.0);
        let (w, h) = unsafe { (*base).base.dims() };
        let model = unsafe {
            (*base).base.refine_model(&raw_core::xmp::AdjustmentModel {
                chroma_prefilter: 60.0,
                deep_denoise: 50.0,
                capture_sharpening_amount: 80.0,
                ..raw_core::xmp::AdjustmentModel::default()
            })
        };
        let usage = model.and_then(|model| {
            let ctx = raw_gpu::GpuContext::new_blocking().ok()?;
            ctx.set_bm3d_binding_cap(limits.1);
            let refined = raw_core::gpu_host::capture::refine::refine_capture_rgba(
                &ctx,
                unsafe { &(*base).base },
                &model,
                &raw_gpu::CancelToken::new(),
            );
            refined.ok().flatten().map(|(_, usage)| usage)
        });
        let mut elapsed = Vec::new();
        let mut peak = 0;
        for tick in 0..12 {
            let sidecar = if tick % 2 == 0 { &all } else { &lighter };
            let before = phys_footprint();
            let started = std::time::Instant::now();
            let ((rc, mut out), high) =
                peak_footprint(|| refine(base, sidecar, budget(limits), std::ptr::null()));
            let ms = started.elapsed().as_secs_f64() * 1000.0;
            assert_eq!(rc, 0);
            unsafe { maple_free_capture_buffer_f32(&mut out) };
            if tick >= 2 {
                elapsed.push(ms);
                peak = peak.max(high.saturating_sub(before));
            }
        }
        elapsed.sort_by(f64::total_cmp);
        let usage = usage.unwrap_or_default();
        eprintln!(
            "capture refine {w}x{h} cap={}MiB: p50={:.1}ms p95={:.1}ms max={:.1}ms \
             GPU images={:.1}MiB GPU transient={:.1}MiB footprint rise={:.1}MiB",
            limits.1 >> 20,
            elapsed[elapsed.len() / 2],
            elapsed[elapsed.len() * 95 / 100],
            elapsed[elapsed.len() - 1],
            usage.image_bytes as f64 / MIB,
            usage.transient_bytes as f64 / MIB,
            peak as f64 / MIB,
        );
        unsafe {
            maple_free_capture_buffer_f32(&mut first);
            maple_free_capture_base(base);
        }
    }
}
