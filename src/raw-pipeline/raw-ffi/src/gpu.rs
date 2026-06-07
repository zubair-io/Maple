//! GPU parity FFI — the Apple-side link+run proof for epic #925 / P1b (#988).
//!
//! Mirrors the WebGPU parity binding (`raw-wasm/src/gpu.rs`): builds the same
//! deterministic RGBA f32 buffer the headless tests use, runs the WGSL exposure
//! kernel GPU-resident via `raw_gpu::run_exposure_gpu` (Metal on Apple), and
//! compares the result to the CPU oracle (`raw_gpu::apply_exposure_gain`),
//! writing the max abs diff so the Swift debug view can assert the 1e-4 gate.
//!
//! The whole module is gated behind `#[cfg(feature = "gpu")]`, so it (and wgpu)
//! is **absent from the default xcframework**. It is compiled only by the opt-in
//! gpu variant (`MAPLE_XCFRAMEWORK_GPU=1 build-xcframework.sh`) and the host
//! validation build. Nothing ships until P5.
//!
//! Threading: `raw_gpu::run_exposure_gpu` constructs its own `GpuContext`
//! (`!Send`/`!Sync` — an `OnceCell` pipeline cache) and consumes it entirely
//! within the single synchronous call, never sharing it across threads, so this
//! entry is safe to call from any one thread (the Swift bridge keeps it on a
//! single owner per the P1a note). Unlike the decode entries it does not need a
//! large worker stack, so it does not route through `with_large_stack`.

/// Build the deterministic `n_pixels`-pixel RGBA f32 test buffer (identical to
/// `raw_gpu`'s `test_buffer` and the wasm parity binding), run the GPU exposure
/// chain at `ev`, and write the max absolute difference vs the CPU oracle into
/// `*out_max_diff`.
///
/// This is the on-device proof that wgpu links AND runs on Metal: a green run
/// (rc 0, `*out_max_diff < 1e-4`) means the WGSL→MSL kernel produced the same
/// pixels as the CPU reference. Device logs aren't capturable on-device, so the
/// caller surfaces `*out_max_diff` in-app.
///
/// Returns:
///   0  success — `*out_max_diff` written
///  -1  `out_max_diff` is null
///  -2  `n_pixels == 0` (nothing to compare)
#[no_mangle]
pub extern "C" fn maple_gpu_exposure_parity(n_pixels: u32, ev: f32, out_max_diff: *mut f32) -> i32 {
    if out_max_diff.is_null() {
        return -1;
    }
    if n_pixels == 0 {
        return -2;
    }

    let n = n_pixels as usize;
    // Same spread as raw_gpu::test_buffer / the wasm binding: some channels
    // exceed 1.0 so the scene-linear multiply is exercised above white.
    let mut input = Vec::with_capacity(n * 4);
    for i in 0..n {
        let t = i as f32 / (n.max(2) - 1) as f32; // 0..=1
        input.extend_from_slice(&[t * 2.0, t, t * 0.5 + 0.25, 1.0]);
    }

    let gpu = raw_gpu::run_exposure_gpu(&input, ev);
    let mut cpu = input;
    raw_gpu::apply_exposure_gain(&mut cpu, ev);

    let max_diff = cpu
        .iter()
        .zip(&gpu)
        .map(|(a, b)| (a - b).abs())
        .fold(0.0_f32, f32::max);

    unsafe {
        *out_max_diff = max_diff;
    }
    0
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Host parity proof: the FFI entry runs the GPU exposure chain (Metal on
    /// macOS) and agrees with the CPU oracle within 1e-4 across a spread of EVs.
    /// Mirrors `raw_gpu`'s `wgsl_exposure_matches_cpu_oracle_within_1e_4` but
    /// through the C ABI surface Apple consumes.
    #[test]
    fn gpu_exposure_parity_within_1e_4() {
        for &ev in &[-3.0_f32, 0.0, 0.5, 4.0] {
            let mut max_diff = f32::NAN;
            let rc = maple_gpu_exposure_parity(256, ev, &mut max_diff);
            assert_eq!(rc, 0, "ev={ev}: parity FFI returned {rc}");
            eprintln!("FFI PARITY ev={ev}: max abs diff = {max_diff:e}");
            assert!(
                max_diff < 1e-4,
                "ev={ev}: GPU vs CPU max abs diff {max_diff} exceeds 1e-4"
            );
        }
    }

    #[test]
    fn gpu_exposure_parity_rejects_null_out() {
        assert_eq!(
            maple_gpu_exposure_parity(256, 0.0, std::ptr::null_mut()),
            -1
        );
    }

    #[test]
    fn gpu_exposure_parity_rejects_zero_pixels() {
        let mut max_diff = f32::NAN;
        assert_eq!(maple_gpu_exposure_parity(0, 0.0, &mut max_diff), -2);
        assert!(max_diff.is_nan(), "out must be untouched on the error path");
    }
}
