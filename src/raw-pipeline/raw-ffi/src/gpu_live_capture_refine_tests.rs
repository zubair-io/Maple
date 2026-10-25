//! The GPU capture refine (#5381) through the FFI: a refine from a decode's
//! base equals a fresh decode at the new stage values within the S0 GPU/CPU
//! gate, everything else is refused, a cancel returns nothing, and the live
//! session's image replacement renders the new pixels exactly.

use super::gpu_live_test_support::scene_linear_rgba;
use super::gpu_live_tests::{make_params, owned_arrays};
use super::gpu_live_wb_frame_tests::gpu_render;
use super::*;
use crate::cancel::{maple_cancel_flag_free, maple_cancel_flag_new, maple_cancel_flag_set};
use crate::capture_base::tests::{chart, empty, pixels, xmp};
use crate::capture_base::{
    maple_free_capture_base, maple_render_file_capture_base_f32, MapleCaptureBase,
};
use crate::capture_creative::{maple_free_capture_buffer_f32, MapleCaptureBufferF32};
use crate::gpu_live::capture_refine::{
    maple_gpu_capture_refine, maple_gpu_live_update_image, MapleCaptureRefineBudget,
};
use raw_core::types::WbMethod;
use raw_core::view::auto_profile::curve::ProfileCurve;
use raw_core::view::auto_profile::lut::ColorLut;
use raw_core::xmp::AdjustmentModel;
use std::ffi::CString;

const ENGAGED: &str =
    "papp:ChromaPrefilter=\"60\" papp:DeepDenoise=\"40\" papp:CaptureSharpeningAmount=\"80\"";

pub(super) const MAC: MapleCaptureRefineBudget = MapleCaptureRefineBudget {
    max_long_edge: 4096,
    bm3d_binding_cap_bytes: 128 << 20,
};

/// Mean, 99.9th percentile and max of the S0 relative error (#5239).
pub(super) fn s0_error(cpu: &[f32], gpu: &[f32]) -> (f64, f32, f32) {
    assert_eq!(cpu.len(), gpu.len());
    let mut errors: Vec<f32> = cpu
        .chunks_exact(4)
        .zip(gpu.chunks_exact(4))
        .flat_map(|(p, q)| (0..3).map(move |c| (p[c] - q[c]).abs() / p[c].abs().max(1.0)))
        .collect();
    errors.sort_unstable_by(f32::total_cmp);
    let mean = errors.iter().map(|e| f64::from(*e)).sum::<f64>() / errors.len() as f64;
    (
        mean,
        errors[errors.len() * 999 / 1000],
        errors[errors.len() - 1],
    )
}

pub(super) fn assert_s0(label: &str, cpu: &[f32], gpu: &[f32]) {
    let (mean, p999, max) = s0_error(cpu, gpu);
    eprintln!("capture refine {label}: mean={mean:e} p99.9={p999:e} max={max:e}");
    assert!(mean <= 1e-6, "{label}: mean relative error {mean}");
    assert!(p999 <= 1e-4, "{label}: p99.9 relative error {p999}");
    assert!(max <= 1e-2, "{label}: max relative error {max}");
}

/// Decode `raw` at `sidecar` with its base.
pub(super) fn decode_with_base(
    raw: &CString,
    sidecar: Option<&CString>,
    edge: u32,
) -> (MapleCaptureBufferF32, *mut MapleCaptureBase) {
    let mut out = empty();
    let mut base = std::ptr::null_mut();
    let rc = unsafe {
        maple_render_file_capture_base_f32(
            raw.as_ptr(),
            sidecar.map_or(std::ptr::null(), |s| s.as_ptr()),
            edge,
            0,
            std::ptr::null(),
            &mut out,
            &mut base,
        )
    };
    assert_eq!(rc, 0, "capture base decode rc {rc}");
    (out, base)
}

pub(super) fn refine(
    base: *const MapleCaptureBase,
    sidecar: &CString,
    budget: MapleCaptureRefineBudget,
    cancel: *const crate::cancel::MapleCancelFlag,
) -> (i32, MapleCaptureBufferF32) {
    let mut out = empty();
    let rc = unsafe { maple_gpu_capture_refine(base, sidecar.as_ptr(), budget, cancel, &mut out) };
    (rc, out)
}

#[test]
fn a_refine_from_the_base_is_the_decode_at_the_new_stages() {
    let dir = tempfile::tempdir().unwrap();
    let raw = chart(&dir);
    // Each stage alone: the noiseless chart is all exact BM3D distance ties,
    // so a last-ULP chroma difference would flip block matches when chained.
    // The chained gate runs on real noise in the physical tests.
    for (label, body) in [
        ("chroma", "papp:ChromaPrefilter=\"60\""),
        ("denoise", "papp:DeepDenoise=\"40\""),
        ("sharpening", "papp:CaptureSharpeningAmount=\"80\""),
    ] {
        let engaged = xmp(&dir, &format!("{label}.xmp"), body);
        refines_to(&raw, &engaged, label);
    }
}

fn refines_to(raw: &CString, engaged: &CString, label: &str) {
    for edge in [0, 160] {
        let (mut first, base) = decode_with_base(raw, None, edge);
        let (rc, mut refined) = refine(base, engaged, MAC, std::ptr::null());
        assert_eq!(rc, 0, "refine rc {rc}");
        let (mut fresh, fresh_base) = decode_with_base(raw, Some(engaged), edge);
        assert_eq!(
            (refined.scene.width, refined.scene.height),
            (fresh.scene.width, fresh.scene.height)
        );
        assert_s0(
            &format!("chart {label} edge={edge}"),
            &pixels(&fresh),
            &pixels(&refined),
        );
        assert_ne!(pixels(&refined), pixels(&first), "the refine moved pixels");
        let (a, b) = (refined.creative.ae_gain, fresh.creative.ae_gain);
        assert!((a - b).abs() <= 1e-4 * b, "ae gain {a} vs {b}");
        assert_eq!(refined.creative.tables, fresh.creative.tables);
        assert_eq!(refined.scene.iso, fresh.scene.iso);
        unsafe {
            maple_free_capture_buffer_f32(&mut first);
            maple_free_capture_buffer_f32(&mut refined);
            maple_free_capture_buffer_f32(&mut fresh);
            maple_free_capture_base(base);
            maple_free_capture_base(fresh_base);
        }
    }
}

#[test]
fn a_refine_is_refused_beyond_its_stages_or_budget_and_drops_on_cancel() {
    let dir = tempfile::tempdir().unwrap();
    let raw = chart(&dir);
    let engaged = xmp(&dir, "engaged.xmp", ENGAGED);
    let recovered = xmp(
        &dir,
        "recovery.xmp",
        &format!("{ENGAGED} papp:HighlightRecoveryMode=\"Off\""),
    );
    let (mut first, base) = decode_with_base(&raw, None, 160);
    let (rc, _) = refine(base, &recovered, MAC, std::ptr::null());
    assert_eq!(rc, 10, "a change outside the refinable stages");
    let phone = MapleCaptureRefineBudget {
        max_long_edge: 100,
        bm3d_binding_cap_bytes: 32 << 20,
    };
    let (rc, _) = refine(base, &engaged, phone, std::ptr::null());
    assert_eq!(rc, 10, "a base over the edge budget");
    let flag = maple_cancel_flag_new();
    unsafe { maple_cancel_flag_set(flag) };
    let (rc, _) = refine(base, &engaged, MAC, flag);
    assert_eq!(rc, 4, "a cancelled refine");
    unsafe { maple_cancel_flag_free(flag) };
    let mut out = empty();
    let rc = unsafe {
        maple_gpu_capture_refine(
            std::ptr::null(),
            engaged.as_ptr(),
            MAC,
            std::ptr::null(),
            &mut out,
        )
    };
    assert_eq!(rc, 1);
    unsafe {
        maple_free_capture_buffer_f32(&mut first);
        maple_free_capture_base(base);
    }
}

#[test]
fn updating_the_live_image_renders_the_new_pixels_exactly() {
    let (w, h) = (48u32, 32u32);
    let before = scene_linear_rgba(w as usize, h as usize);
    let after: Vec<f32> = before
        .chunks_exact(4)
        .flat_map(|p| [p[2] * 0.9, p[0], p[1] * 1.1, 1.0])
        .collect();
    let model = AdjustmentModel {
        exposure: 0.4,
        ..AdjustmentModel::default()
    };
    let arrays = owned_arrays(&model, &ProfileCurve::identity(), &ColorLut::identity(2));
    let params = make_params(&after, &model, WbMethod::DiagonalRec2020, 2, &arrays);
    let want = gpu_render(&after, w, h, &params);

    let mut handle = MapleGpuLiveSession {
        inner: std::ptr::null_mut(),
    };
    unsafe {
        assert_eq!(maple_gpu_live_open(before.as_ptr(), w, h, &mut handle), 0);
        assert_eq!(
            maple_gpu_live_update_image(&mut handle, after.as_ptr(), w, h + 1),
            -3
        );
        assert_eq!(
            maple_gpu_live_update_image(&mut handle, after.as_ptr(), w, h),
            0
        );
        let mut got = vec![0u8; (w * h * 3) as usize];
        assert_eq!(maple_gpu_live_render(&handle, &params, got.as_mut_ptr()), 0);
        maple_gpu_live_close(&mut handle);
        assert_eq!(got, want);
        assert_eq!(
            maple_gpu_live_update_image(&mut handle, after.as_ptr(), w, h),
            -1,
            "a closed session"
        );
    }
}
